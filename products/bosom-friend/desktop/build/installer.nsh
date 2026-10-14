; Bosom Friend installer hook: prepare the bundled kernel runtime at install time.
;
; Why: kernel-runtime.zip is ~62.5 MB / 23,297 entries (~430 MB unpacked). Extracting it on first launch
; (electron/electron/main.cjs ensureKernelExtracted) blocks the splash screen for many
; minutes on low-end machines with a mechanical disk. Doing it here moves that cost into
; the installer, and the app then finds runtime\bin-desktop.mjs immediately.
;
; Contract with electron/main.cjs kernelRootForVersion(): the runtime lives in the fixed
; directory userData/kernel-runtime and is refreshed on every install, so it always matches
; the installed version. If this directory is missing (silent/portable install, or the
; extraction below failed) the app falls back to self-extracting kernel-runtime-<version>.
;
; Keep this file ASCII-only: makensis reads included files with the ANSI codepage unless
; they carry a BOM, so non-ASCII text here would show up garbled in the installer log.

; Extraction ladder, mirroring electron/kernel-extract.cjs in the app:
;   1. $SYSDIR\tar.exe          - ships with Windows 10 1803+, fastest by far;
;   2. built-in unpacker        - resources\kernel-unzip.cjs run by the bundled Node. This is the
;                                 only step that survives a machine without tar.exe AND without
;                                 long-path support (see below), so keep it before the Python;
;   3. bundled portable Python  - legacy last resort for installs whose kernel-unzip.cjs or
;                                 runtime\node.exe is missing; it cannot unpack paths over MAX_PATH
;                                 unless the machine has LongPathsEnabled=1.
;
; Why step 2 exists: the unpacked runtime contains paths of ~290 characters under %APPDATA%
; (deepest zip entry is 232 characters). Windows long-path support is OFF by default, and both
; Python's zipfile and libuv only honour long paths when the process is long-path aware AND
; HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled is 1. kernel-unzip.cjs
; prefixes \\?\ itself, so it does not depend on either.
; A failure here is NOT fatal, but it must never be silent: the app would otherwise unpack 430MB
; on the splash screen and a user would only see a broken app minutes later (DEF-046).
; Pre-install platform gate (customInit runs before any file is copied).
;
; Product baseline: the desktop shell is Electron 33, which needs Windows 10 1809+ / Windows 11.
; On Windows 7 SP1 the installer used to copy ~2.7 GB and then the app could not start at all
; (Windows reports "not a valid Win32 application"), while all three unpackers also failed with
; -1073741515 (0xC0000135: the bundled Node 24 / Python 3.12 cannot start there). Measured on a
; Windows 7 SP1 machine on 2026-09-18: the user waited through a full install for nothing.
;
; Rules that keep this zero-risk for supported machines:
;   - only the ABSENCE of CurrentMajorVersionNumber is treated as "older than Windows 10";
;   - an unreadable registry key is NOT treated as legacy (never abort on unknown);
;   - silent installs never see a dialog (they keep their exit-code semantics and get the log line).
!macro customInit
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" CurrentMajorVersionNumber
  ReadRegStr $1 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" CurrentVersion
  ReadRegStr $2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" CurrentBuildNumber
  DetailPrint "Windows: CurrentVersion=$1 CurrentBuildNumber=$2 CurrentMajorVersionNumber=$0"
  StrCmp $0 "" 0 bf_os_has_major
  StrCmp $1 "" bf_os_ok
bf_os_has_major:
  StrCmp $0 "10" bf_os_ok
  StrCmp $0 "11" bf_os_ok
  StrCmp $0 "" bf_os_legacy
  Goto bf_os_ok
bf_os_legacy:
  DetailPrint "Unsupported Windows ($1 build $2): Bosom Friend needs Windows 10 1809 or Windows 11."
  IfSilent bf_os_ok
  MessageBox MB_ICONSTOP|MB_OK "Bosom Friend requires Windows 10 (1809) or Windows 11.$\r$\nThis computer reports Windows $1 (build $2). The app and its built-in unpackers cannot start on it, so setup will exit without changing anything.$\r$\nPlease install on a Windows 10/11 computer, or upgrade this one first."
  Abort
bf_os_ok:
!macroend

!macro customInstall
  DetailPrint "Preparing the built-in runtime (a few minutes, please do not close this installer)..."
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c if exist "$APPDATA\Bosom Friend\kernel-runtime" rmdir /s /q "$APPDATA\Bosom Friend\kernel-runtime"'
  Pop $0
  CreateDirectory "$APPDATA\Bosom Friend\kernel-runtime"

  ; --- Windows long path support (one UAC prompt, non-silent only) -------------------------
  ; The unpacked runtime contains paths of ~290 characters under %APPDATA%; Windows long path
  ; support is OFF by default. Extraction does not need it (kernel-unzip.cjs prefixes \\?\
  ; itself), but the KERNEL PROCESS reading those files does: Python's zipfile and libuv only
  ; honour long paths when the process is long-path aware AND LongPathsEnabled is 1.
  ; Doing it here means the user's only action is "run the installer" - no repair kit, no manual
  ; reg add. Skipped in silent installs (never raise UAC without a visible reason), and a declined
  ; prompt is reported honestly instead of being treated as success.
  ClearErrors
  ReadRegDWORD $0 HKLM "SYSTEM\CurrentControlSet\Control\FileSystem" "LongPathsEnabled"
  IfErrors 0 bf_longpaths_read
    StrCpy $0 "0"
  bf_longpaths_read:
  StrCmp $0 "1" bf_longpaths_end
    IfSilent bf_longpaths_silent
      DetailPrint "Enabling Windows long path support (please accept the UAC prompt)..."
      ; ExecShell gives neither a wait nor an exit code, so the registry is polled afterwards:
      ; the only accepted evidence is "the value really reads 1".
      ExecShell "runas" "$SYSDIR\reg.exe" 'add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f' SW_HIDE
      StrCpy $1 0
  bf_longpaths_wait:
      Sleep 1000
      IntOp $1 $1 + 1
      ClearErrors
      ReadRegDWORD $0 HKLM "SYSTEM\CurrentControlSet\Control\FileSystem" "LongPathsEnabled"
      IfErrors 0 bf_longpaths_check
        StrCpy $0 "0"
  bf_longpaths_check:
      StrCmp $0 "1" bf_longpaths_ok
      IntCmp $1 30 bf_longpaths_denied bf_longpaths_wait bf_longpaths_denied
  bf_longpaths_ok:
      DetailPrint "Long path support enabled (LongPathsEnabled=1)."
      Goto bf_longpaths_end
  bf_longpaths_denied:
      DetailPrint "Long path support was NOT enabled (no admin consent after $1s)."
      DetailPrint "Extraction still works through the built-in unpacker, but the kernel may fail to"
      DetailPrint "read deep runtime files. Re-run this installer, or enable it later as an"
      ; Single-quoted NSIS string so the double quotes inside survive (NSIS escapes quotes with $\" only).
      DetailPrint 'administrator: reg add "HKLM\SYSTEM\CurrentControlSet\Control\FileSystem" /v LongPathsEnabled /t REG_DWORD /d 1 /f'
      MessageBox MB_ICONEXCLAMATION|MB_OK "Bosom Friend works best with Windows long path support, which needs one administrator approval.$\r$\nThe built-in runtime was still installed. If the app does not open, run this installer again and accept the prompt, or enable LongPathsEnabled as an administrator."
      Goto bf_longpaths_end
    bf_longpaths_silent:
      DetailPrint "Silent install: LongPathsEnabled left unchanged (currently 0)."
  bf_longpaths_end:

  ; [2026-10-12, DEF-275 follow-up] A silent install (/S) must not raise UAC for long paths,
  ; and the first rung (tar.exe) provably fails on deep paths when LongPathsEnabled is 0
  ; (see lines 25-31: the unpacked runtime reaches ~290 chars under %APPDATA%).
  ; A partial failure is worse than a slow one: it leaves a HALF-EXTRACTED runtime in userData
  ; (measured on 0.3.8: 0-byte runtime\bin-desktop.mjs, 20 of 248 scope packages).
  ; The app side now detects that (kernelRuntimeReady requires size > 0), but the cleanest fix
  ; is to not create the half state at all: in silent installs go straight to the built-in
  ; unpacker, which prefixes long paths itself and therefore does not depend on the registry.
  IfSilent bf_kernel_force_builtin

  IfFileExists "$SYSDIR\tar.exe" 0 bf_kernel_no_tar
    DetailPrint "Unpacking with $SYSDIR\tar.exe ..."
    nsExec::ExecToLog '"$SYSDIR\tar.exe" -xf "$INSTDIR\resources\kernel-runtime.zip" -C "$APPDATA\Bosom Friend\kernel-runtime"'
    Pop $0
    StrCmp $0 "0" 0 bf_kernel_tar_failed
      Delete "$INSTDIR\resources\kernel-runtime.zip"
      Goto bf_kernel_done

bf_kernel_tar_failed:
  StrCpy $R0 $0
  DetailPrint "tar.exe exited with code $0; trying the built-in unpacker instead."

bf_kernel_force_builtin:
bf_kernel_no_tar:
  ; The built-in unpacker (resources\kernel-unzip.cjs, run by the bundled Node) is the only
  ; extraction path that does not depend on PATH or on the machine's long-path setting: the
  ; runtime contains paths of ~290 characters once unpacked into %APPDATA%, and both tar.exe
  ; and the bundled Python fail on a machine where LongPathsEnabled is 0 (the Windows default).
  IfFileExists "$INSTDIR\resources\runtime\node.exe" 0 bf_kernel_no_node
  IfFileExists "$INSTDIR\resources\kernel-unzip.cjs" 0 bf_kernel_no_node
    DetailPrint "Unpacking with the built-in unpacker (long-path safe, a few minutes) ..."
    nsExec::ExecToLog '"$INSTDIR\resources\runtime\node.exe" "$INSTDIR\resources\kernel-unzip.cjs" "$INSTDIR\resources\kernel-runtime.zip" "$APPDATA\Bosom Friend\kernel-runtime"'
    Pop $0
    StrCmp $0 "0" 0 bf_kernel_node_failed
      Delete "$INSTDIR\resources\kernel-runtime.zip"
      Goto bf_kernel_done

bf_kernel_node_failed:
  StrCpy $R1 $0
  DetailPrint "The built-in unpacker exited with code $0; trying the bundled Python instead."

bf_kernel_no_node:
  IfFileExists "$INSTDIR\resources\engine\python-base\python.exe" 0 bf_kernel_no_python
    DetailPrint "Unpacking with the bundled Python (no usable tar.exe on this machine) ..."
    nsExec::ExecToLog '"$INSTDIR\resources\engine\python-base\python.exe" -m zipfile -e "$INSTDIR\resources\kernel-runtime.zip" "$APPDATA\Bosom Friend\kernel-runtime"'
    Pop $0
    StrCmp $0 "0" 0 bf_kernel_python_failed
      Delete "$INSTDIR\resources\kernel-runtime.zip"
      Goto bf_kernel_done

bf_kernel_no_python:
  StrCpy $0 "no-unpacker"

bf_kernel_python_failed:
  ; Per-rung codes are recorded so a failed install is diagnosable from the log alone: reporting only
  ; the last rung cost half a day on 2026-09-18 (a Windows 7 machine reported -1073741515 from the
  ; Python rung while the Node rung had failed for the same reason). Printed before IfSilent on purpose.
  DetailPrint "Unpack ladder result: tar=$R0 node=$R1 python=$0"
  DetailPrint "(codes: 0 = ok, no-tar = tar.exe absent, -1073741515 = 0xC0000135, the unpacker could not start)"
  DetailPrint "Built-in runtime was NOT unpacked here (code $0)."
  DetailPrint "Bosom Friend keeps resources\kernel-runtime.zip and unpacks it on first launch,"
  DetailPrint "which takes a few minutes on a slow disk. The first launch will look slow; do not delete the zip."
  IfSilent bf_kernel_done
  MessageBox MB_ICONEXCLAMATION|MB_OK "The built-in runtime could not be unpacked during setup (code: $0).$\r$\nBosom Friend will unpack it automatically on first launch, which can take a few minutes on slow disks.$\r$\nPlease leave resources\kernel-runtime.zip in the install folder."

bf_kernel_done:
!macroend

; Removal hook.
;
; The fixed kernel-runtime dir is re-extracted on every install, and the fallback
; kernel-runtime-<version> dirs are re-extractable too, so none of them are user data.
; A real machine had accumulated 8 of them (~8.9 GB) because nothing ever removed them.
; User data lives in %USERPROFILE%\.bosom-friend and MUST survive an uninstall.
;
; The whole %APPDATA%\Bosom Friend tree goes too: after that removal the directory only
; holds Chromium profile state (Local Storage / IndexedDB / Service Worker / Preferences)
; plus regenerated diagnostics (perf-profile.json, gpu-crash.json). Verified on 2026-09-13:
; removing only kernel-runtime* and the named caches left 127 files behind, so
; "uninstall leaves nothing" was not actually true. Nothing user-authored lives there.
!macro customUnInstall
  DetailPrint "Removing the built-in runtime and rebuildable caches..."
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c for /d %d in ("$APPDATA\Bosom Friend\kernel-runtime*") do @rd /s /q "%d"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c rd /s /q "$APPDATA\Bosom Friend\Cache"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c rd /s /q "$APPDATA\Bosom Friend\Code Cache"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c rd /s /q "$APPDATA\Bosom Friend\GPUCache"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c rd /s /q "$APPDATA\Bosom Friend\DawnGraphiteCache"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c rd /s /q "$APPDATA\Bosom Friend\DawnWebGPUCache"'
  Pop $0
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /c rd /s /q "$APPDATA\Bosom Friend"'
  Pop $0
  DetailPrint "User data under %USERPROFILE%\.bosom-friend is kept."
!macroend
