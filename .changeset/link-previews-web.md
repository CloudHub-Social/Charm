---
default: patch
---

Add web (browser) support for link previews (Spec 29), proxying the homeserver's `/preview_url` endpoint through the companion server. Matches the existing desktop implementation and stays behind the default-off `link_previews` feature flag.
