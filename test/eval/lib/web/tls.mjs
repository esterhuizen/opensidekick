// A throwaway self-signed certificate, made at runtime with the openssl CLI
// (Chromium runs with --ignore-certificate-errors, so SANs don't matter).
// Nothing is committed, so no secret scanner ever sees a private key.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "osk-eval-tls-"));
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=eval.test", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error("Couldn't make a TLS certificate: the eval needs the openssl CLI on PATH (" + (e.code || e.message) + ")");
  }
  const tls = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), dir };
  tls.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return tls;
}
