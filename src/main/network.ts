import { getCACertificates, setDefaultCACertificates } from "node:tls";

export function configureSystemTrust(): void {
  setDefaultCACertificates([...new Set([
    ...getCACertificates("default"),
    ...getCACertificates("system"),
  ])]);
}
