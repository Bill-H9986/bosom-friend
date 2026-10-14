# Release Process

## Version

The next release version is `0.2.0`. Version changes are one commit with a release note.

## Build pipeline

```text
source
  -> unit tests
  -> desktop build
  -> desktop E2E on a clean Windows profile
  -> NSIS package
  -> isolated install test
  -> process-leak check
  -> checksum and release note
```

## Packaging rules

- Use `electron-builder` NSIS, per-user install.
- Installer must not force-launch the app (`runAfterFinish: false` by default).
- Create desktop and start menu shortcuts to the desktop EXE.
- Uninstall keeps user data unless the user explicitly chooses otherwise.
- No setup BAT/VBS installed beside the app.

## Release evidence

Each release records:

- version and Git commit
- artifact name and SHA256
- installed path
- startup screenshot or machine check
- close/process-leak check
- known platform limitations

No release is called stable unless the desktop user path and process leak checks pass.
