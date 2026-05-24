# Local TLS material

Self-signed CA + `bbstat.localhost` server cert used by the dev backend
(`apps/backend/src/index.ts`), Vite (`apps/frontend/vite.config.ts`), and the
dev Traefik (`compose.override.yaml`). **Everything in this directory except
`server.san` and this README is gitignored** — per-developer fixtures, not
committed material.

Top-level [README.md "Local TLS"](../../README.md#local-tls) is the surface
reference (what to do on a fresh clone). This doc is the cookbook for the
underlying commands — generating the CA, issuing the server cert against
`server.san`, and getting the CA trusted by your OS and Chrome.

All commands assume you are running them from `etc/tls/` (this directory).
`openssl` 3.x.

## Files

| File                       | Source        | Purpose                                                                              |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `server.san` (committed)   | hand-written  | OpenSSL request config — CN + SAN list for the server cert. The only durable fixture. |
| `ca.key` / `ca.crt`        | generated     | Local development CA. Re-trusted on every developer machine after generation.        |
| `ca.srl`                   | generated     | OpenSSL serial counter for the CA. Created automatically on first `x509 -CAcreateserial`. |
| `server.key`               | generated     | Server private key (RSA-2048). Loaded by backend + Vite + Traefik.                   |
| `server.csr`               | generated     | Certificate signing request — transient intermediate, safe to delete after signing.  |
| `server.crt`               | generated     | Server certificate signed by the local CA.                                           |

## 1. Generate the local CA (one-time per developer)

You only need to do this once. The CA key and cert are valid for a long time
(10 years below) so you can keep re-issuing server certs from them without
re-trusting.

```bash
# CA private key (RSA-2048). Keep this file readable only by your user.
openssl genrsa -out ca.key 2048
chmod 600 ca.key

# Self-signed CA cert. `-days 3650` = 10 years. Pick whatever CN you like;
# it shows up in the browser trust store as the issuer name.
openssl req -x509 -new -nodes -key ca.key \
  -sha256 -days 3650 \
  -subj "/CN=ShipShow Local Dev CA" \
  -out ca.crt
```

Verify:

```bash
openssl x509 -in ca.crt -noout -subject -issuer -dates
```

After this step, jump to **section 3** to trust the CA in your OS and browser
before the first time you load the dev URL — otherwise Chrome will block the
page and `curl` will need `-k`.

## 2. Issue the server certificate (one-time, or whenever it expires)

`server.san` is the request config that controls the cert's CN and SAN list.
Edit it if you need a new hostname (e.g., adding another `*.localhost` alias);
otherwise re-use it verbatim.

```bash
# Server private key.
openssl genrsa -out server.key 2048
chmod 600 server.key

# CSR using server.san for CN + SAN.
openssl req -new -key server.key -out server.csr -config server.san

# Sign with the CA. `-extensions v3_req -extfile server.san` carries the
# SAN entries into the final cert (otherwise the SAN block in the CSR is
# dropped). `-CAcreateserial` initializes ca.srl on first run; subsequent
# issuances use `-CAserial ca.srl` automatically.
openssl x509 -req -in server.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 365 -sha256 \
  -extensions v3_req -extfile server.san

# server.csr is no longer needed.
rm -f server.csr
```

Verify the SANs landed correctly:

```bash
openssl x509 -in server.crt -noout -subject -issuer -dates -ext subjectAltName
```

Expected output ends with something like:

```
X509v3 Subject Alternative Name:
    DNS:bbstat.localhost, DNS:localhost, DNS:traefik.localhost, IP Address:127.0.0.1
```

Server certs in the snippet above are valid for 1 year (`-days 365`). When
they expire, repeat **section 2** only — the CA stays trusted, so no
re-import step is needed.

## 3. Trust the CA on Linux (system store)

This makes `curl`, `wget`, every Node / Go / Python HTTP client, and most
GUI apps trust certificates issued by your local CA without `-k` / `--insecure`
flags. Browsers are a separate story — see **section 4**.

### Fedora / RHEL / CentOS

```bash
sudo cp ca.crt /etc/pki/ca-trust/source/anchors/bbstat-local-dev-ca.crt
sudo update-ca-trust extract
```

### Debian / Ubuntu

The trust tool here is fussy about extensions — the file MUST end in `.crt`
under `/usr/local/share/ca-certificates/`, and the input must be a single
PEM cert (no chain).

```bash
sudo cp ca.crt /usr/local/share/ca-certificates/bbstat-local-dev-ca.crt
sudo update-ca-certificates
```

### Arch / Manjaro

```bash
sudo trust anchor --store ca.crt
```

### Verify

```bash
curl -v https://bbstat.localhost:8443/ 2>&1 | grep -i "ssl\|verify\|certificate"
# Expect: "SSL certificate verify ok" — no -k needed.
```

If `curl` still complains, your shell session may have an old `SSL_CERT_FILE`
/ `SSL_CERT_DIR` override pointing somewhere else — `env | grep SSL_CERT` to
check.

## 4. Trust the CA in your browser

### Chrome / Chromium on Linux

Chrome on Linux uses its own NSS-backed trust store at `~/.pki/nssdb` and
**does NOT pick up the system CA bundle**. Adding to `update-ca-trust` is
not enough — you need `certutil` from the NSS tools package.

```bash
# Install the NSS tools (once per machine).
sudo dnf install nss-tools          # Fedora / RHEL
# OR
sudo apt install libnss3-tools      # Debian / Ubuntu

# Initialize ~/.pki/nssdb if it doesn't exist yet. Empty password is fine.
mkdir -p $HOME/.pki/nssdb
certutil -d sql:$HOME/.pki/nssdb -N --empty-password 2>/dev/null || true

# Trust the CA for TLS server auth (the `C,,` flags).
certutil -d sql:$HOME/.pki/nssdb \
  -A -t "C,," -n "ShipShow Local Dev CA" -i ca.crt

# Verify.
certutil -d sql:$HOME/.pki/nssdb -L | grep -i shipshow
```

Restart Chrome. The next load of `https://bbstat.localhost:5173` should be
green-locked, no warning page, no "Not secure" badge.

**To remove later:**

```bash
certutil -d sql:$HOME/.pki/nssdb -D -n "ShipShow Local Dev CA"
```

### Firefox

Firefox uses a per-profile NSS DB (`~/.mozilla/firefox/<profile>/cert9.db`)
and ignores the system store too. Easiest path is the GUI:

1. `about:preferences#privacy` → scroll to **Certificates** → **View Certificates**
2. **Authorities** tab → **Import…** → pick `ca.crt`
3. Check "Trust this CA to identify websites" → OK

CLI alternative is the same `certutil` command above with
`-d sql:$HOME/.mozilla/firefox/<profile>` as the DB path.

### Chrome / Edge / Safari on macOS

These honour the system Keychain. Double-click `ca.crt` → it opens in
Keychain Access → drag it into the **System** keychain → double-click it →
**Trust** section → set "When using this certificate" to **Always Trust**.
Restart the browser.

### Chrome / Edge on Windows

These honour the Windows trust store. Double-click `ca.crt` → **Install
Certificate** → **Local Machine** → **Place all certificates in the
following store** → **Trusted Root Certification Authorities** → Finish.
Restart the browser.

## Re-issuance / rotation playbook

| When                                                | What to redo                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Server cert expired (1 year by default)             | Re-run **section 2** only. CA stays trusted; no re-import.                                                    |
| Need a new SAN (added a new `*.localhost` hostname) | Edit `server.san` → re-run **section 2** only.                                                                |
| CA expired or compromised                           | Re-run **sections 1 + 2 + 3 + 4**. Every developer has to re-trust the new CA — coordinate ahead of time.     |
| Switched machines                                   | Copy `ca.crt` / `ca.key` / `server.key` / `server.crt` over (or generate fresh — they're per-developer fixtures). Re-trust per **3 + 4** on the new machine. |

**Do not regenerate `ca.crt` / `ca.key` casually** once other developers
have trusted them — every machine has to re-import the new CA, which is
a coordinated annoyance. Server cert re-issuance from the same CA is
free.
