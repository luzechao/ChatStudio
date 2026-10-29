import assert from "node:assert/strict";
import test from "node:test";
import { X509Certificate } from "node:crypto";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { configureSystemTrust } from "../src/main/network.js";

test("agent trust includes default and OS certificates without disabling TLS verification", () => {
  const defaults = getCACertificates("default");
  const system = getCACertificates("system");
  const rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    configureSystemTrust();
    const fingerprint = (certificate: string) => new X509Certificate(certificate).fingerprint256;
    const configured = new Set(getCACertificates("default").map(fingerprint));
    for (const certificate of [...defaults, ...system]) assert.ok(configured.has(fingerprint(certificate)));
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, rejectUnauthorized);
    const count = configured.size;
    configureSystemTrust();
    assert.equal(new Set(getCACertificates("default").map(fingerprint)).size, count);
  } finally {
    setDefaultCACertificates(defaults);
  }
});
