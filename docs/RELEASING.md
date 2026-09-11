# Release Checklist

Use this checklist to create a Windows release without adding private
subscription data to Git.

1. Update desktop-app/package.json and CHANGELOG.md with the version.
2. Put the official mihomo.exe and geoip.metadb beside desktop-app for the
   local packaging step. They remain ignored by Git.
3. From desktop-app, run:

       npm ci
       npm run verify
       npm run dist

4. Calculate the installer hash:

       Get-FileHash .\release\Fingerprint-Proxy-Setup-<version>.exe -Algorithm SHA256

5. Commit the reviewed source files, create an annotated v<version> tag, and
   push both the default branch and the tag.
6. Create a GitHub Release from that tag. Upload the installer and blockmap,
   then put the SHA-256 in the release notes.
7. Verify the release page from a clean browser session. Do not attach YAML,
   logs, cache files, or screenshots sourced from a real subscription.
