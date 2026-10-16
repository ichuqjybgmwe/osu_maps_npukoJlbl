; Установщик MapVault для Windows (Inno Setup 6).
; Сборка: сначала `npm run build:win`, затем
;   iscc installer\mapvault.iss
; Результат: dist\MapVault-Setup-<версия>.exe
;
; Установка в профиль пользователя (без прав администратора). Данные (база,
; логи, кэш) лежат в %APPDATA%\MapVault и при удалении программы НЕ удаляются.

#define AppName "MapVault"
#define AppVersion "0.1.0"
#define AppExe "MapVault.exe"
#define SrcDir "..\dist\MapVault-" + AppVersion + "-win-x64"

[Setup]
AppId={{6C1E7C52-9A0B-4F3E-9C7B-0F3D2B6A9E11}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=MapVault
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=MapVault-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExe}
CloseApplications=yes

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SrcDir}\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\ИНСТРУКЦИЯ.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\Инструкция MapVault"; Filename: "{app}\ИНСТРУКЦИЯ.md"
Name: "{group}\Папка данных MapVault"; Filename: "{userappdata}\MapVault"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
