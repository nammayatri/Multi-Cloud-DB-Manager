# passetto-server-x86_64

Vendored from `nammayatri/Backend/dev/config-sync/bin/passetto-server-x86_64`.
Used by `config_transfer.py`'s `patch` command to spin up a temporary
encryption server (see `_start_temp_passetto()` in the script) — required for
`patch`, not for `export`.

## Why this binary needs patching before it will run here

It's a Nix-built ELF whose interpreter and RPATH are hardcoded to absolute
`/nix/store/...` paths (glibc 2.37, ncurses, libffi, gmp, zlib, libsodium,
postgresql-lib). Those paths don't exist on a plain Debian image, so a direct
`exec` fails with a misleading "No such file or directory" error even though
the file is present and executable.

Verified fix (tested against the real binary on a Debian 12 host): every
actual shared-library *dependency* the binary needs already resolves via
normal Debian paths (confirmed with `ldd`) — only the ELF interpreter path
itself is wrong. So the fix is a one-time `patchelf` rewrite, not extra
runtime packages beyond what's already in the Dockerfile:

```bash
# Run once, before committing an updated binary to this repo:
apt-get install -y patchelf   # or: brew install patchelf (macOS)
patchelf --set-interpreter /lib64/ld-linux-x86-64.so.2 \
         --set-rpath /lib/x86_64-linux-gnu \
         passetto-server-x86_64
```

After patching, verify it loads correctly (it should print a config error,
NOT a "No such file or directory" error):

```bash
./passetto-server-x86_64
# expected: "exited: Missing env variable: MASTER_PASSWORD"
```

If nammayatri's upstream binary is ever re-vendored/updated, re-run this
patch step before committing the replacement.
