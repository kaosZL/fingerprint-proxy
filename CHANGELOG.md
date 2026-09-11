# Changelog

All notable changes to this project are documented in this file.

## [1.0.1] - 2026-09-11

### Changed

- Closing the main window now hides Fingerprint Proxy to the Windows system
  tray instead of exiting the application.
- Added a system-tray context menu with Show window and Quit actions.

## [1.0.0] - 2026-09-11

### Added

- Windows x64 Electron desktop application for turning local Clash/Mihomo YAML
  files into per-node SOCKS5 or HTTP entrances for fingerprint browsers.
- YAML source snapshots, change detection, local-only Mihomo controls,
  proxy-import.txt copy support, logs, port validation and configuration
  integrity checks.
- Safe public example YAML, fixture-only tests and a privacy publication check.
- GitHub Actions CI and a scheduled star-monitor workflow.
