; CheapRouter's Windows installer (fork of Waku's; the executable keeps its
; internal name `waku.exe` — only user-visible identity is branded).
;
; Per-user by design: %LOCALAPPDATA%\Programs needs no elevation, which is
; what lets the in-app updater re-run this silently without a UAC prompt.
; See RELEASING.md and docs/windows.md.
;
; Built by scripts/bundle-windows.ts, which supplies:
;   /DAppVersion=<version>  /DArch=<x86_64|aarch64>
;   /DStageDir=<dir with the built executables>  /DOutputDir=<dir>

#ifndef AppVersion
  #error AppVersion must be defined (ISCC /DAppVersion=...)
#endif
#ifndef Arch
  #error Arch must be defined (ISCC /DArch=...)
#endif
#ifndef StageDir
  #error StageDir must be defined (ISCC /DStageDir=...)
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

; An x64 build is worth allowing on Arm, where it runs emulated; an arm64
; build on x64 is not, so refuse it up front rather than installing something
; that cannot start.
#if Arch == "aarch64"
  #define Architectures "arm64"
#else
  #define Architectures "x64compatible"
#endif

; Supplied by bundle-windows.ts after release preflight; fallbacks preserve development.
#ifndef ProductName
  #define ProductName "CheapRouter"
#endif
#ifndef ProductAppId
  #define ProductAppId "7DC6C35B-FA40-4A95-B37A-626BF64556C5"
#endif
#ifndef ProductPublisher
  #define ProductPublisher "CheapRouter"
#endif
#ifndef ProductWebsite
  #define ProductWebsite "https://cheaprouter.cc"
#endif
#ifndef ProductReleasesURL
  #define ProductReleasesURL "https://github.com/ai-poet/agent-client/releases"
#endif
#ifndef ProductDirectory
  #define ProductDirectory "CheapRouter"
#endif
#ifndef ProductMutex
  #define ProductMutex "CheapRouterSetup"
#endif

[Setup]
; Once a site first ships, keep its configured AppId stable: it is how Windows and every later installer recognize
; an existing install, and how the updater replaces rather than duplicates it.
; This is the fork's own GUID, minted before the first release — it must not
; collide with upstream Waku's, so the two products can coexist on one machine.
AppId={{{#ProductAppId}}
AppName={#ProductName}
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
AppPublisher={#ProductPublisher}
AppPublisherURL={#ProductWebsite}
AppSupportURL={#ProductWebsite}
AppUpdatesURL={#ProductReleasesURL}
DefaultDirName={autopf}\{#ProductDirectory}
DefaultGroupName={#ProductName}
UninstallDisplayName={#ProductName}
UninstallDisplayIcon={app}\waku.exe
LicenseFile={#StageDir}\LICENSE
OutputDir={#OutputDir}
OutputBaseFilename={#ProductName}-{#AppVersion}-{#Arch}-Setup
SetupIconFile=AppIcon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed={#Architectures}
ArchitecturesInstallIn64BitMode={#Architectures}
; What docs/windows.md promises. Enforcing it here beats installing onto a
; system that cannot run the result.
MinVersion=10.0.17763
; Two installers must not race — the updater can be triggered again while an
; update is already applying.
SetupMutex={#ProductMutex}
; No elevation, so an update never has to ask for it either.
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
DisableReadyPage=yes
; The updater passes /DIR, and a manual reinstall should land where the
; previous one did rather than asking again.
UsePreviousAppDir=yes
; The app persists continuously to SQLite, so closing it is safe; a silent
; update cannot stop to ask, and a locked waku.exe would fail the install.
CloseApplications=force
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#StageDir}\waku.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\waku-daemon.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
; Computer Use: the QuickJS REPL the agents talk to, the Pi extension that
; registers it, and the Windows skill — all resolved relative to waku.exe.
Source: "{#StageDir}\waku_js_repl.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#StageDir}\computer-use\pi-extension.ts"; DestDir: "{app}\computer-use"; Flags: ignoreversion
Source: "{#StageDir}\skills\waku-computer-use\SKILL.md"; DestDir: "{app}\skills\waku-computer-use"; Flags: ignoreversion

[Icons]
Name: "{group}\{#ProductName}"; Filename: "{app}\waku.exe"
Name: "{userdesktop}\{#ProductName}"; Filename: "{app}\waku.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Run]
; No skipifsilent: this is also how the updater's silent run brings the app back.
Filename: "{app}\waku.exe"; Description: "{cm:LaunchProgram,{#ProductName}}"; Flags: nowait postinstall
