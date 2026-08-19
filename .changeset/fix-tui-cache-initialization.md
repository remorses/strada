---
'strada': patch
---

Fix TUI startup by initializing Termcast before importing the module that restores persisted state from `Cache`.

Running `strada` now opens the TUI with the correct `~/.termcast/compiled/strada` storage context instead of creating its module-scope cache before Termcast is ready.
