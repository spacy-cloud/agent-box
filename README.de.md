# abox - Agent Sandbox Manager (Kurzfassung)

Lokale Sandboxes für KI-Agenten. Eine Umgebung wird einmal als Template beschrieben und lässt sich
per **CLI**, **MCP-Server** oder **Electron-GUI** erstellen, benutzen und wieder entfernen - unter
einer Policy, die der Nutzer festlegt und der Agent nicht ändern kann.

Die ausführliche Beschreibung (englisch) steht in der [README.md](README.md).

> [!WARNING]
> **Status: frühe Entwicklung, noch kein Release.** Es gibt keine veröffentlichten Pakete und keine
> stabilen Schnittstellen oder Dateiformate. Mit Änderungen ist jederzeit zu rechnen.

> [!CAUTION]
> **Sicherheitshinweis.** Container teilen sich den Kernel mit dem Host. abox verringert das Risiko
> durch gehärtete Standardwerte, Pfadprüfung, Freigaben und einen Egress-Proxy, ersetzt aber
> **keine geprüfte Sicherheitsarchitektur**. Bitte vor dem Einsatz [docs/security.md](docs/security.md)
> lesen, insbesondere die Liste der bekannten Einschränkungen (englisch).

## Kernideen

- **Backend-neutral:** Docker/Podman, Host-Prozess, Python und VMs sind austauschbare Backends hinter
  einem Interface; alle müssen dieselbe Vertragstestsuite bestehen.
- **Agenten-Steuerung zuerst:** MCP, Policy mit Freigaben und Skills sind Kernfunktionen. Die
  Durchsetzung liegt im Core, nicht in der Oberfläche.
- **Der Host entscheidet:** Ein Agent kann Rechte anfragen, aber weder Policy noch Freigabemodus
  ändern.
- **Lokal zuerst, keine Telemetrie:** kein Konto, kein Cloud-Dienst, keine Nutzungsdaten.
- **Ehrlich bei Grenzen:** Jede Isolationsstufe dokumentiert, wovor sie schützt und wovor nicht.

## Bausteine

Core-Bibliothek, Backends (Docker/Podman, Prozess, Python, VM), CLI `abox`, MCP-Server,
Claude-Code-Plugin `agent-kit`, Electron-GUI, Hosts/SSH (Sandboxes auf entfernten Rechnern) und ein
Orca-Plugin. Den aktuellen Stand je Baustein zeigt die Tabelle in der [README.md](README.md).

## Voraussetzungen und Bauen

- Linux, Docker oder Podman (rootless empfohlen), Node.js >= 24, pnpm 10.

```sh
pnpm install
pnpm build
pnpm test
pnpm test:docker   # Integrationstests gegen eine echte Container-Engine
```

## Pakete und Lizenz

Der npm-Name `abox` ist bereits vergeben; veröffentlichte Pakete erscheinen später unter dem Scope
`@spacy-cloud/`. Das Kommando heißt `abox`. Mitarbeit: [CONTRIBUTING.md](CONTRIBUTING.md),
Sicherheitslücken bitte privat melden: [SECURITY.md](SECURITY.md). Lizenz: [MIT](LICENSE).
