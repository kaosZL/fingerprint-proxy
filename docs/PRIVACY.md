# Privacy Model

## Why real YAML files are excluded

A Clash/Mihomo YAML usually contains more than display names. It can contain
node hostnames or IP addresses, ports, passwords, UUIDs, private keys, SNI
values, provider URLs, and subscription metadata. Publishing it can expose an
account and makes the node inventory searchable.

The following classes of local files are intentionally ignored and must remain
local:

- Any root-level `.yaml` or `.yml` file
- proxy-import.txt
- cache.db
- mihomo.exe and geoip.metadb

The original files are left untouched on the workstation so the existing
workflow continues to work. The repository instead includes
[examples/config.example.yaml](../examples/config.example.yaml), where every
endpoint uses example.invalid and every credential is a placeholder.

## Publishing checklist

1. Keep subscription exports outside the Git repository, or in an ignored
   local file.
2. Use a generic fixture when demonstrating a bug.
3. Do not publish screenshots that show a source filename, file path, node
   label, server, port, or generated import line from a real subscription.
4. Run npm run privacy:check from desktop-app before committing.

The CI workflow runs the same check. It rejects known private files and only
allows the reviewed YAML examples tracked by this repository.
