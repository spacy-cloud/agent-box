<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.png">
    <img src="docs/assets/logo.png" alt="abox" width="160">
  </picture>
</p>

# abox - Agent Sandbox Manager (Kurzfassung)

Lokale Sandboxes für KI-Agenten. Eine Umgebung wird einmal als Template beschrieben und lässt sich
per **CLI**, **MCP-Server** oder **Electron-GUI** erstellen, benutzen und wieder entfernen - unter
einer Policy, die der Nutzer festlegt und der Agent nicht ändern kann.

Die ausführliche Beschreibung (englisch) steht in der [README.md](README.md).

> [!WARNING]
> **Status: Vorabversion, noch kein Release.** Es gibt keine veröffentlichten Pakete (kein npm,
> kein veröffentlichtes AppImage, kein Release-Tag). CLI, MCP-Server, fünf Backends, das Claude-Code-Plugin und die
> GUI sind im Repository umgesetzt, aber Schnittstellen, JSON-Ausgabe und Dateiformate sind **nicht
> stabil**. Was nicht geprüft ist, steht in
> [docs/security.md](docs/security.md#known-limitations-and-not-verified) (englisch).

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

## Bausteine und Stand

| Baustein                                                                                                  | Stand                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core (Template-Engine, Lebenszyklus, Policy und Freigaben, Audit-Log)                                     | umgesetzt                                                                                                                                         |
| Docker-Backend                                                                                            | umgesetzt, gegen eine Docker-Engine mit Root-Daemon getestet                                                                                      |
| Podman-Backend                                                                                            | umgesetzt, **nicht** gegen ein echtes Podman geprüft                                                                                              |
| Python-Backend (Container mit `uv`, oder Host-venv ohne Isolation)                                        | umgesetzt                                                                                                                                         |
| VM-Backend (QEMU/KVM, eigener Kernel; braucht `/dev/kvm`, x86_64)                                         | umgesetzt                                                                                                                                         |
| Prozess-Backend (keine Isolation, deutlich markiert)                                                      | umgesetzt                                                                                                                                         |
| CLI `abox`, MCP-Server (Werkzeuge siehe [Katalog](docs/mcp-catalog.md), stdio und lokales HTTP mit Token) | umgesetzt                                                                                                                                         |
| Claude-Code-Plugin `agent-kit`                                                                            | umgesetzt; Auslösung des Skills nur headless geprüft (Einzelproben), Slash-Befehle ungeprüft                                                      |
| Hosts/SSH (Sandboxes auf entfernten Rechnern)                                                             | umgesetzt, experimentell; nur gegen einen lokalen sshd-Container geprüft                                                                          |
| Orca-Plugin                                                                                               | umgesetzt; nicht in einem laufenden Orca getestet                                                                                                 |
| Electron-GUI                                                                                              | umgesetzt (E2E-Tests unter xvfb bestehen, AppImage baut lokal); nicht veröffentlicht                                                              |
| Pakete (npm, AppImage, AUR)                                                                               | AppImage baut aus dem Quellcode, AUR-`PKGBUILD` geschrieben, npm geplant; nichts veröffentlicht, siehe [packaging/README.md](packaging/README.md) |

## Voraussetzungen und Bauen

- Linux (einzige unterstützte Plattform), Docker oder Podman (rootless empfohlen), Node.js >= 24, pnpm 10.
- Optional: `/dev/kvm` und QEMU (VM-Backend), `secret-tool` (Schlüsselbund), OpenSSH (Remote-Hosts).

```sh
git clone https://github.com/spacy-cloud/agent-box.git
cd agent-box
pnpm install
pnpm build
mkdir -p ~/.local/bin && ln -sf "$PWD/packages/cli/dist/bin.js" ~/.local/bin/abox
abox doctor
abox doctor --for flutter-dev   # kann ich diese Vorlage (oder host:<id>) ausführen?
abox create alpine-min --name scratch && abox exec scratch -- sh -c 'echo hallo' && abox rm -f scratch
claude mcp add abox -- abox mcp serve --agent claude-code
pnpm test           # Unit-, Vertrags- und Sicherheitstests
pnpm test:docker    # zusätzlich Integrationstests gegen eine echte Container-Engine
```

## Dokumentation (englisch)

[Quickstart](docs/quickstart.md) · [Template-Handbuch](docs/templates.md) · [CLI](docs/cli.md) ·
[MCP](docs/mcp.md) · [Werkzeug-Katalog](docs/mcp-catalog.md) · [Fehlercodes](docs/errors.md) · [Claude Code und andere Agenten](docs/claude-code.md) ·
[Backends](docs/backends.md) · [Hosts und SSH](docs/hosts-ssh.md) · [GUI](docs/gui.md) ·
[Fehlerbehebung](docs/troubleshooting.md) · [Architektur](docs/architecture.md) ·
[Sicherheitsmodell](docs/security.md)

## Pakete und Lizenz

Der npm-Name `abox` ist bereits vergeben; veröffentlichte Pakete erscheinen später unter dem Scope
`@spacy-cloud/`. Das Kommando heißt `abox`. Mitarbeit: [CONTRIBUTING.md](CONTRIBUTING.md),
Sicherheitslücken bitte privat melden: [SECURITY.md](SECURITY.md). Lizenz: [MIT](LICENSE).
