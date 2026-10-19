---
title: How Signet works
description: Where the data on this site comes from.
---

Signet reports what Apple's servers say. None of the data on this site is entered by hand.

## Signing status

For each firmware, Signet sends a signing request to Apple's signing server, `gs.apple.com`, the same server iTunes, Finder and Apple Configurator use. If Apple returns a signature, the firmware is **signed**. If Apple refuses, it's **not signed**. Each page shows when the check ran.

## Firmware lists

- IPSW restore images come from Apple's update feeds on `mesu.apple.com` and `itunes.apple.com`.
- Over-the-air updates come from Apple's update server, `gdmf.apple.com`. Encrypted `.aea` packages are listed with the key Apple publishes for them.
- File sizes are read from Apple's CDN. SHA-1 hashes are the ones Apple publishes.

## Device details

Model names, boards, chips and displays are read from the firmware itself (the device tree inside each IPSW). Retail specs and product images come from Apple's Tech Specs pages on `support.apple.com`. Chip photos come from Wikimedia Commons and are credited on each page.

## Downloads

Download links point to `updates.cdn-apple.com`. Signet never hosts, modifies or proxies files. To check a download, compare its SHA-1 with the one on the device page:

```sh
shasum -a 1 iPhone17,1_27.0.1_24A446_Restore.ipsw
```

Signet is an independent project and isn't affiliated with Apple Inc.
