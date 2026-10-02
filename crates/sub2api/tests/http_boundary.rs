//! Exercise the public client through its real curl transport, never a live service.
//! Fixture URLs are deliberately ignored: only bodies and catalog paths are used.
//! No credential store, environment mutation, app, or extra dependency is involved.

use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use sub2api::{Client, http::ApiError};

const SERVER_TIMEOUT: Duration = Duration::from_secs(5);
const ACCEPT_INTERVAL: Duration = Duration::from_millis(10);
const MAX_REQUEST_BYTES: usize = 64 * 1024;
const ACCESS: &str = "FIXTURE_ONLY_ACCOUNT_ACCESS";
const REFRESH: &str = "FIXTURE_ONLY_ACCOUNT_REFRESH";
const CODE: &str = "FIXTURE_ONLY_ONE_TIME_CODE";
const VERIFIER: &str = "FIXTURE_ONLY_VERIFIER";

struct ObservedRequest {
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Value,
}

/// One connection only. Accept sleeps on a cancellation channel; socket I/O
/// shares an absolute deadline, so partial reads cannot extend the budget.
/// Drop also joins on panic. Client calls retain the transport's own 20s limit
/// (the public Client does not offer a timeout override).
struct Server {
    endpoint: String,
    stop: Sender<()>,
    worker: Option<JoinHandle<Result<ObservedRequest>>>,
}

impl Server {
    fn start(status: u16, body: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback fixture server");
        let endpoint = format!("http://{}", listener.local_addr().expect("local address"));
        listener.set_nonblocking(true).expect("nonblocking accept");
        let (stop, cancelled) = mpsc::channel();
        let worker = thread::spawn(move || serve(listener, cancelled, status, body));
        Self {
            endpoint,
            stop,
            worker: Some(worker),
        }
    }

    fn finish(&mut self) -> ObservedRequest {
        self.worker
            .take()
            .expect("server joined only once")
            .join()
            .expect("fixture server panicked")
            .expect("fixture server failed or timed out")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| anyhow!("fixture server deadline exceeded"))
}

fn read_more(stream: &mut TcpStream, bytes: &mut Vec<u8>, deadline: Instant) -> Result<()> {
    stream.set_read_timeout(Some(remaining(deadline)?))?;
    ensure!(bytes.len() < MAX_REQUEST_BYTES, "fixture request too large");
    let mut buffer = [0; 4096];
    let capacity = buffer.len().min(MAX_REQUEST_BYTES - bytes.len());
    let count = stream.read(&mut buffer[..capacity])?;
    ensure!(count != 0, "incomplete fixture request");
    bytes.extend_from_slice(&buffer[..count]);
    Ok(())
}

fn read_request(stream: &mut TcpStream, deadline: Instant) -> Result<ObservedRequest> {
    let mut bytes = Vec::new();
    let header_end = loop {
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            break end + 4;
        }
        read_more(stream, &mut bytes, deadline)?;
    };
    let header = std::str::from_utf8(&bytes[..header_end])?;
    let mut lines = header.split("\r\n");
    let parts: Vec<_> = lines
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .collect();
    ensure!(parts.len() == 3, "invalid fixture request line");
    ensure!(parts[2] == "HTTP/1.1", "unexpected fixture HTTP version");
    let method = parts[0].to_owned();
    let path = parts[1].to_owned();
    let mut headers = BTreeMap::new();
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').context("invalid fixture header")?;
        ensure!(
            headers
                .insert(name.to_ascii_lowercase(), value.trim().to_owned())
                .is_none(),
            "duplicate fixture header"
        );
    }
    ensure!(
        !headers.contains_key("transfer-encoding"),
        "unexpected chunked request"
    );
    let length = headers
        .get("content-length")
        .context("missing fixture content-length")?
        .parse::<usize>()?;
    ensure!(
        length <= MAX_REQUEST_BYTES - header_end,
        "fixture body too large"
    );
    let end = header_end + length;
    while bytes.len() < end {
        read_more(stream, &mut bytes, deadline)?;
    }
    ensure!(bytes.len() == end, "unexpected bytes after fixture body");
    let body = serde_json::from_slice(&bytes[header_end..end])?;
    Ok(ObservedRequest {
        method,
        path,
        headers,
        body,
    })
}

fn serve(
    listener: TcpListener,
    cancelled: Receiver<()>,
    status: u16,
    body: String,
) -> Result<ObservedRequest> {
    let deadline = Instant::now() + SERVER_TIMEOUT;
    let mut stream = loop {
        let wait = remaining(deadline)?.min(ACCEPT_INTERVAL);
        match listener.accept() {
            Ok((stream, peer)) => {
                ensure!(peer.ip().is_loopback(), "fixture peer is not loopback");
                break stream;
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                match cancelled.recv_timeout(wait) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    _ => bail!("fixture server cancelled"),
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    };
    drop(listener);
    stream.set_nonblocking(false)?;
    let request = read_request(&mut stream, deadline)?;
    let response = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let mut bytes = response.as_bytes();
    while !bytes.is_empty() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        let count = stream.write(bytes)?;
        ensure!(count != 0, "fixture response write stalled");
        bytes = &bytes[count..];
    }
    Ok(request)
}

fn run<T>(
    status: u16,
    body: String,
    call: impl FnOnce(&Client) -> Result<T>,
) -> (Result<T>, ObservedRequest) {
    let mut server = Server::start(status, body);
    let result = call(&Client::new(format!("{}/", server.endpoint)));
    let request = server.finish();
    assert_eq!(
        request.headers.get("host").map(String::as_str),
        server.endpoint.strip_prefix("http://")
    );
    (result, request)
}

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).expect("valid contract fixture")
}

fn golden_body(id: &str, side: &str) -> Value {
    let golden = fixture(include_str!("../../../docs/contracts/fixtures/account-golden.json"));
    golden["cases"]
        .as_array()
        .expect("golden cases")
        .iter()
        .find(|case| case["id"] == id)
        .expect("golden case")[side]["body"]
        .clone()
}

fn assert_request(request: &ObservedRequest, id: &str) {
    let catalog = fixture(include_str!("../../../docs/contracts/calls-v1.json"));
    let call = catalog["calls"]
        .as_array()
        .expect("call catalog")
        .iter()
        .find(|call| call["id"] == id)
        .expect("catalog case");
    assert_eq!(request.method, "POST");
    assert_eq!(request.method, call["method"].as_str().unwrap());
    assert_eq!(request.path, call["path"].as_str().unwrap());
    assert_eq!(request.body, call["request"]);
    assert_eq!(request.body, golden_body(id, "request"));
    assert_eq!(
        request.headers.get("content-type").map(String::as_str),
        Some("application/json")
    );
    let host = request.headers.get("host").expect("host header");
    assert!(host.starts_with("127.0.0.1:"));
    assert!(host["127.0.0.1:".len()..].parse::<u16>().unwrap() > 0);
    for name in [
        "authorization",
        "cookie",
        "x-auth-session",
        "proxy-authorization",
    ] {
        assert!(!request.headers.contains_key(name), "unexpected {name}");
    }
}

fn assert_safe_diagnostic(error: &anyhow::Error, secrets: &[&str]) {
    let rendered = format!("{error}\n{error:#}\n{error:?}");
    for secret in secrets {
        assert!(
            !rendered.contains(secret),
            "synthetic secret leaked in diagnostic"
        );
    }
}

#[test]
fn exchange_sends_code_and_verifier_and_decodes_managed_session() {
    let (result, request) = run(200, golden_body("A07", "response").to_string(), |client| {
        client.exchange_desktop_code(CODE, VERIFIER)
    });
    assert_request(&request, "A07");
    let session = result.expect("valid exchange");
    assert_eq!(session.access_token, ACCESS);
    assert_eq!(session.refresh_token, REFRESH);
    assert_eq!(session.expires_in, 900);
    assert_eq!(session.api_key.as_deref(), Some("FIXTURE_ONLY_MODEL_KEY"));
    assert!(session.claude_api_key.is_none());
    assert!(session.codex_api_key.is_none());
}

#[test]
fn refresh_sends_only_refresh_body_and_decodes_valid_pair() {
    let body = include_str!("../../../docs/contracts/fixtures/refresh-valid.json");
    assert_eq!(fixture(body), golden_body("A06", "response"));
    let (result, request) = run(200, body.to_owned(), |client| client.refresh(REFRESH));
    assert_request(&request, "A06");
    let pair = result.expect("valid refresh");
    assert_eq!(pair.access_token, ACCESS);
    assert_eq!(pair.refresh_token, REFRESH);
    assert_eq!(pair.expires_in, 900);
}

#[test]
fn native_success_envelopes_are_rejected_on_both_auth_endpoints() {
    for body in [
        include_str!("../../../docs/contracts/fixtures/native-refresh-success.json"),
        include_str!("../../../docs/contracts/fixtures/native-self-success.json"),
    ] {
        let (refresh, request) = run(200, body.to_owned(), |client| client.refresh(REFRESH));
        assert_request(&request, "A06");
        let (exchange, request) = run(200, body.to_owned(), |client| {
            client.exchange_desktop_code(CODE, VERIFIER)
        });
        assert_request(&request, "A07");
        // DesktopSession intentionally has no Debug implementation.
        for error in [
            refresh.err().expect("native refresh rejected"),
            exchange.err().expect("native exchange rejected"),
        ] {
            assert!(format!("{error:#}").contains("incompatible with client-api-v1"));
            assert!(error.downcast_ref::<ApiError>().is_none());
            assert_safe_diagnostic(&error, &[ACCESS, REFRESH, "FIXTURE_ONLY_NATIVE_ACCESS"]);
        }
    }
}

#[test]
fn invalid_refresh_payloads_never_become_token_pairs() {
    let mut bodies: Vec<String> = [
        include_str!("../../../docs/contracts/fixtures/refresh-missing-fields.json"),
        include_str!("../../../docs/contracts/fixtures/refresh-empty-token.json"),
        include_str!("../../../docs/contracts/fixtures/refresh-empty-refresh-token.json"),
        include_str!("../../../docs/contracts/fixtures/refresh-nonpositive-expiry.json"),
        include_str!("../../../docs/contracts/fixtures/refresh-negative-expiry.json"),
        include_str!("../../../docs/contracts/fixtures/refresh-string-expiry.json"),
        include_str!("../../../docs/contracts/fixtures/envelope-empty-data.json"),
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    let boundary = fixture(include_str!("../../../docs/contracts/fixtures/boundary-cases.json"));
    bodies.extend(
        boundary["bad_refresh"]
            .as_array()
            .unwrap()
            .iter()
            .map(|case| case["body"].to_string()),
    );
    let mut whitespace = fixture(include_str!("../../../docs/contracts/fixtures/refresh-valid.json"));
    whitespace["data"]["refresh_token"] = json!(" \t\n");
    bodies.push(whitespace.to_string());
    for body in bodies {
        let (result, request) = run(200, body, |client| client.refresh(REFRESH));
        assert_request(&request, "A06");
        let error = result.expect_err("invalid refresh rejected");
        assert!(error.downcast_ref::<ApiError>().is_none());
        assert_safe_diagnostic(&error, &[ACCESS, REFRESH]);
    }
}

#[test]
fn http_status_and_business_reason_keep_auth_and_retry_errors_distinct() {
    for (status, reason, auth_rejection) in [
        (401, "UNAUTHORIZED", true),
        (403, "FORBIDDEN", true),
        (429, "RATE_LIMITED", false),
        (502, "BAD_GATEWAY", false),
        // The refresh reason also ends a session on an HTTP 200 business error.
        (200, "REFRESH_TOKEN_INVALID", true),
    ] {
        let code = if status == 200 {
            400
        } else {
            i64::from(status)
        };
        let body = json!({"code": code, "reason": reason, "message": "fixture rejection", "data": null});
        let (result, request) = run(status, body.to_string(), |client| client.refresh(REFRESH));
        assert_request(&request, "A06");
        let error = result.expect_err("service rejection");
        let api = error.downcast_ref::<ApiError>().expect("typed API error");
        assert_eq!(api.status, status);
        assert_eq!(api.code, code);
        assert_eq!(api.reason, reason);
        assert_eq!(api.message, "fixture rejection");
        assert_eq!(api.is_auth_rejection(), auth_rejection);
    }
    let body = include_str!("../../../docs/contracts/fixtures/native-auth-error.json");
    let (result, _) = run(401, body.to_owned(), |client| client.refresh(REFRESH));
    let error = result.expect_err("native auth rejection");
    let api = error.downcast_ref::<ApiError>().expect("typed native HTTP error");
    assert_eq!(api.status, 401);
    assert_eq!(api.code, 401); // A native string code is not a numeric managed code.
    assert!(api.is_auth_rejection());
}

#[test]
fn malformed_responses_report_location_without_echoing_synthetic_tokens() {
    for body in [
        format!(r#"{{"code":0,"data":{{"access_token":"{ACCESS}","refresh_token":"{REFRESH}",broken}}}}"#),
        json!({
            "code": 0,
            "data": {
                "access_token": ACCESS,
                "refresh_token": REFRESH,
                "expires_in": ACCESS,
            },
        })
        .to_string(),
    ] {
        let (result, request) = run(200, body.clone(), |client| client.refresh(REFRESH));
        assert_request(&request, "A06");
        let (exchange, request) = run(200, body, |client| {
            client.exchange_desktop_code(CODE, VERIFIER)
        });
        assert_request(&request, "A07");
        for error in [
            result.err().expect("malformed refresh rejected"),
            exchange.err().expect("malformed exchange rejected"),
        ] {
            let diagnostic = format!("{error:#}");
            assert!(diagnostic.contains("incompatible with client-api-v1"));
            assert!(diagnostic.contains("HTTP 200, line "));
            assert!(diagnostic.contains("column "));
            assert_safe_diagnostic(&error, &[ACCESS, REFRESH, CODE, VERIFIER]);
        }
    }
    // Non-JSON HTTP failures must not include a proxy's raw body either.
    let (result, _) = run(502, format!("proxy body {ACCESS} {REFRESH}"), |client| {
        client.refresh(REFRESH)
    });
    let error = result.expect_err("malformed gateway response rejected");
    let api = error.downcast_ref::<ApiError>().expect("typed gateway error");
    assert_eq!(api.status, 502);
    assert!(!api.is_auth_rejection());
    assert_safe_diagnostic(&error, &[ACCESS, REFRESH]);
}

#[test]
fn unused_server_is_cancelled_and_joined_without_a_connection() {
    let server = Server::start(200, "{}".to_owned());
    drop(server); // Exercises the same cleanup used if the client cannot spawn curl.
}
