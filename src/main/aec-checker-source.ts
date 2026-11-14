// Bundled AEC compatibility resources. No installed Skill or AEC checkout is used at runtime.
export const ARC_CHECKER_SOURCE = String.raw`#!/usr/bin/env python3
# ARC managed compatibility checker version=arc-1
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import urllib.error
import urllib.parse
import urllib.request

def digest(value):
    return hashlib.sha256(value).hexdigest()

def git(root, *args):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, timeout=30)
    if result.returncode:
        raise ValueError("Cannot verify Git state: " + result.stderr.decode("utf-8", errors="replace").strip())
    return result.stdout


def safe_file(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative or any(p in ("", ".", "..") for p in relative.split("/")):
        raise ValueError("Invalid workspace relative path")
    file = root / relative
    for part in [file, *file.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise ValueError(f"Linked evidence/source is not trusted: {relative}")
    return file


def current_hash(root, relative):
    file = safe_file(root, relative)
    return digest(file.read_bytes()) if file.is_file() else None


def live_access(root):
    """Use only the explicit local ARC binding, never discover or guess secrets."""
    bindings = set()
    for file in root.iterdir():
        if file.name.casefold() in ("agents.md", "claude.md") and file.is_file() and not file.is_symlink():
            text = file.read_text(encoding="utf-8")
            blocks = re.finditer(r"<!--\s*(arc-engineering|ai-engineering-context):start version=arc-1\s*-->(.*?)<!--\s*\1:end version=arc-1\s*-->", text, re.S)
            for block in blocks:
                for match in re.finditer(r"<!-- arc-connection-file: (.*?) -->", block[2]):
                    bindings.add(json.loads(match[1]))
    if len(bindings) != 1:
        raise ValueError("ARC mode requires --arc-record or one explicit Agent connection binding; connect the project in ARC")
    binding = Path(bindings.pop())
    if not binding.is_absolute():
        raise ValueError("ARC connection binding must be absolute")
    connection = json.loads(binding.read_text(encoding="utf-8"))
    url = urllib.parse.urlsplit(connection["url"])
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.path != "/tool" or url.username or url.password or url.query or url.fragment:
        raise ValueError("ARC connection must be an authenticated local loopback endpoint")
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise ValueError("ARC checker refuses redirects")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    def call(name, args):
        payload = json.dumps({"name": name, "args": args, "client": {"configured_provider": "codex", "name": "arc-aec-checker"}}).encode("utf-8")
        request = urllib.request.Request(connection["url"], data=payload, headers={"Authorization": "Bearer " + connection["token"], "Content-Type": "application/json"})
        with opener.open(request, timeout=15) as response:
            body = response.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024:
            raise ValueError("ARC response exceeds checker limit")
        value = json.loads(body)
        if "value" not in value:
            raise ValueError("ARC did not return a saved record")
        return value["value"]
    return call


def live_record(call, root, task_id=None):
    context = call("arc_engineering_context", {"workspace_path": str(root)})
    if Path(context.get("workspace", {}).get("root_path", "")).resolve() != root:
        raise ValueError("ARC context belongs to a different workspace")
    if task_id:
        return call("arc_development_task", {"task_id": task_id}), context
    tasks = context.get("recent_tasks", [])
    if not tasks:
        raise ValueError("ARC has no task for this workspace")
    task = max(tasks, key=lambda item: item["updated_at"])
    return call("arc_development_task", {"task_id": task["task_id"]}), context


def check_record(root: Path, record_path: Path | None, task_id=None, data_dir: Path | None=None):
    """Validate an exported ARC task against the actual workspace, not file counts."""
    try:
        root = root.resolve()
        call, context = None, None
        if record_path:
            record = json.loads(record_path.read_text(encoding="utf-8-sig"))
        else:
            call = live_access(root)
            record, context = live_record(call, root, task_id)
        if not isinstance(record, dict) or not record.get("task_id") or not record.get("goal") or not record.get("summary"):
            raise ValueError("Missing task identity, goal or actual outcome")
        if task_id and record.get("task_id") != task_id:
            raise ValueError("Requested task identity does not match the record")
        if Path(record.get("workspace_path", "")).resolve() != root:
            raise ValueError("Task belongs to a different workspace")
        if record.get("saved") != "saved" or record.get("status") != "completed":
            raise ValueError("Task is unsaved, pending, failed, blocked or cancelled")
        if record.get("changes_status") == "needs_review":
            raise ValueError("Task change ownership requires review")
        end = record.get("end_state") or {}
        if context:
            state = context.get("code_state", {})
            if not end.get("workspace_fingerprint") or any(end.get(key) != state.get(key) for key in ("workspace_fingerprint", "head", "branch", "git_common_dir")):
                if end.get("head") != state.get("head"):
                    raise ValueError("Task end HEAD does not match the current checkout")
                raise ValueError("Changed content is stale or task workspace coverage is incomplete")
        if not isinstance(record.get("baseline"), dict) or not end.get("fingerprint"):
            raise ValueError("Task baseline and end code state are required")
        head = git(root, "rev-parse", "HEAD").decode().strip()
        if end.get("head") != head:
            raise ValueError("Task end HEAD does not match the current checkout")
        changes = record.get("changes")
        if not isinstance(changes, list):
            raise ValueError("Missing actual changes")
        declared = {}
        for change in changes:
            if not isinstance(change, dict):
                raise ValueError("Invalid changed-file record")
            relative = change["path"]
            if relative in declared:
                raise ValueError("Duplicate changed file")
            if "after_sha256" not in change:
                raise ValueError("Missing changed-file content state")
            declared[relative] = change["after_sha256"]
            if current_hash(root, relative) != declared[relative]:
                raise ValueError(f"Changed content is stale: {relative}")
        baseline_head = (record.get("diff_baseline") or record["baseline"]).get("head")
        if not isinstance(baseline_head, str) or not re.fullmatch(r"[0-9a-f]{40,64}", baseline_head):
            raise ValueError("Git task baseline HEAD is missing")
        # Existing user edits may remain dirty or be committed during the task;
        # either way, only an unchanged frozen baseline hash exempts the path.
        preexisting = {item["path"]: item.get("sha256") for item in record.get("preexisting_files", [])}
        committed_paths = git(root, "diff", "--name-only", "-z", baseline_head, head).split(b"\0")
        for relative in (p.decode("utf-8") for p in committed_paths if p):
            if relative not in declared and not (relative in preexisting and current_hash(root, relative) == preexisting[relative]):
                raise ValueError(f"Committed task change is not recorded: {relative}")
        # An unrelated dirty path may be excluded only with its actual baseline hash.
        dirty = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").split(b"\0")
        index = 0
        while index < len(dirty):
            entry = dirty[index]
            index += 1
            if not entry:
                continue
            rel = entry[3:].decode("utf-8")
            relatives = [rel]
            if b"R" in entry[:2] or b"C" in entry[:2]:
                relatives.append(dirty[index].decode("utf-8"))
                index += 1
            for relative in relatives:
                # The external exported receipt itself is not a code change.
                if record_path and (root / relative).resolve() == record_path.resolve():
                    continue
                if relative not in declared and not (relative in preexisting and current_hash(root, relative) == preexisting[relative]):
                    raise ValueError(f"Actual Git change is not covered by task/baseline: {relative}")
        evidence = record.get("verification")
        if not isinstance(evidence, list) or not evidence:
            raise ValueError("Missing verification evidence (a relevant inspection is sufficient)")
        # Retained failures are history. A successful retry of the same command
        # at the current code state supersedes its earlier result for this gate.
        current_evidence = {}
        for item in evidence:
            if not isinstance(item, dict):
                raise ValueError("Invalid verification record")
            proof = item.get("code_state", {})
            keys = ("workspace_fingerprint", "head", "branch", "git_common_dir") if end.get("workspace_fingerprint") else ("fingerprint", "head")
            if all(proof.get(key) == end.get(key) for key in keys):
                current_evidence[(item.get("command"), item.get("cwd"))] = item
        if not current_evidence:
            raise ValueError("Verification refers to a different code state")
        self_reported = 0
        for item in current_evidence.values():
            if not item.get("command") or Path(item.get("cwd", "")).resolve() != root:
                raise ValueError("Verification command/cwd missing or wrong workspace")
            if item.get("outcome") != "passed" or item.get("exit_code") != 0:
                raise ValueError("Verification is failed, blocked or not run")
            if item.get("origin") == "self_reported":
                self_reported += 1
            elif item.get("origin") == "observed":
                log = item.get("log_path")
                if item.get("code_state_verified") is False or not end.get("workspace_fingerprint"):
                    raise ValueError("Observed verification code coverage is incomplete")
                if not log or not log.startswith((f"development/{record['task_id']}/", f"logs/{record['task_id']}/")):
                    raise ValueError("Observed verification requires a task-scoped execution log")
                try:
                    if call:
                        call("arc_verification_log", {"task_id": record["task_id"], "workspace_path": str(root), "path": log})
                    elif not data_dir or not safe_file(data_dir.resolve(), log).is_file():
                        raise ValueError("An exported record requires --arc-data-dir with the referenced execution log")
                except urllib.error.HTTPError as exc:
                    raise ValueError("Observed verification execution log is missing or outside this task") from exc
            else:
                raise ValueError("Unknown evidence origin")
        print(f"ARC_RECORD_OK: task={record['task_id']}; changes and evidence checked; self_reported={self_reported} (not independently verified)")
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(f"ARC_RECORD_FAILED: {exc}")
        return 2


def main():
    parser = argparse.ArgumentParser(description="Validate the connected ARC task and actual workspace evidence")
    parser.add_argument("--root", default=".")
    parser.add_argument("--context-mode", choices=("auto", "arc"), default="arc")
    parser.add_argument("--arc-record")
    parser.add_argument("--task")
    parser.add_argument("--arc-data-dir", type=Path, help="ARC data directory for logs referenced by --arc-record")
    args = parser.parse_args()
    return check_record(Path(args.root), Path(args.arc_record) if args.arc_record else None, args.task, args.arc_data_dir)

if __name__ == "__main__":
    raise SystemExit(main())
`;
export const PREVIOUS_ARC_CHECKER_SHA256 = "03721e782c1b5703dd583632b91a1a1b5c68c0adabeaaf24e965d22537cb9bdf";
export const ARC_MIGRATION_ADAPTER_SOURCE = "#!/usr/bin/env python3\n# ARC managed migration adapter version=arc-1\nimport argparse\nfrom pathlib import Path\nimport re\n\ndef main():\n    parser = argparse.ArgumentParser(description=\"Validate ARC managed rules without recreating legacy REQ files\")\n    parser.add_argument(\"--target\", \"--root\", default=\".\")\n    parser.add_argument(\"--mode\", choices=(\"dry-run\", \"apply\", \"ensure\", \"check\"), default=\"dry-run\")\n    parser.add_argument(\"--context-mode\", choices=(\"auto\", \"arc\"), default=\"arc\")\n    parser.add_argument(\"--apply\", action=\"store_true\")\n    args = parser.parse_args()\n    root = Path(args.target).resolve()\n    found = False\n    for file in root.iterdir():\n        if file.name.casefold() not in (\"agents.md\", \"claude.md\"):\n            continue\n        if file.is_symlink():\n            raise ValueError(\"Linked rules are not supported\")\n        text = file.read_text(encoding=\"utf-8\")\n        for namespace in (\"arc-engineering\", \"ai-engineering-context\"):\n            markers = list(re.finditer(r\"<!--\\s*\" + namespace + r\":(start|end)(?:\\s+version=([A-Za-z0-9_.-]+))?\\s*-->\", text))\n            signals = re.findall(r\"<!--\\s*\" + namespace + r\":(?:start|end)\\b\", text)\n            if not signals:\n                continue\n            if len(markers) != 2 or len(signals) != 2 or [m[1] for m in markers] != [\"start\", \"end\"] or any(m[2] != \"arc-1\" for m in markers):\n                raise ValueError(\"Outdated or malformed managed rules; reconnect this project in ARC\")\n            found = True\n    if not found:\n        raise ValueError(\"No ARC managed binding; connect this project in ARC\")\n    print(\"ARC_RULES_CURRENT: managed rules verified; historical files unchanged; task evidence is checked by check_ai_context.py\")\n    return 0\n\nif __name__ == \"__main__\":\n    try:\n        raise SystemExit(main())\n    except (OSError, ValueError) as error:\n        print(\"ARC_RULES_FAILED: \" + str(error))\n        raise SystemExit(2)\n";
export const OFFICIAL_AEC_SCRIPT_HASHES: Record<string, string[]> = {
  "scripts/check_ai_context.py": [
    "13a33f97ac76e3f1ade220c1f873687a330864a1b6208ae36a26ee898f9dc3ad",
    "2274a70233b2a5f48c804e2b9b07ae235db6ae81f3801d6a8263107da7961785",
    "3698c8e29f821a045aeddad395898fa7d5b6dd24dc3e0e55f27374a7f787b46d",
    "425750eb05448d448c3cd499e689d1940558fa594786755694cdd4d06ec84e2f",
    "57fdbbcba532dbe4014e433a31c5d5b9dbbb38a8c42f62b8c7767000e2d539c6",
    "76fc1a2ae6acfd82298e727f58dce1cc519ee2ee0f2d6cd540dd0ba9038b2ec2",
    "88db088e53f74b49af07585644519c72ab2d347fc6d647eedaa78c0d82fbfbfd",
    "9246c99d41ed5e2005cdd016a41d241cbc2a0eb8b658d5e4bb108c14164050b7",
    "94dd62bd1621e14cd69ed8460fb457e2d987b7f2744c0ae4553e8bf5d3277b66",
    "9544aa8322bb45d95ceb9492aa8ae4e8f25d7c7efc980ca5e838c9659324f065",
    "97c37d58448df31b7a09c3d978c5a52b6d10c6b5a308aad382df2df936c6c2a9",
    "cc3af40f076b09633b48f0cacc0995d7d23606c5390f6e0eeb8a7a4cc29dd97a",
    "ee32a69ca34103d6e69387d51e688952afa4b2dff144e348d178c5aeb7353579",
    "f8b8204a4766c87254335d29ce04d90b3067a4a722838d0ad4416985dda3845a",
    "f9d9f9962ae19adfb95c9a10bfc278a600b9daa51d79c795ff26c32e42d5c7e4"
  ],
  "scripts/collect_delivery_evidence.py": [
    "0aaf4f40b4f467d1b4d6d384c1892f4542d72a0a86177ce0efebe260dd0db9d9",
    "32f3bc050c7605f6c162ce69b69a46c83e5487f05b95a5f5014047c1d501607e",
    "f81774b7e7c64ba2082bcd2eed82b39c03fc9ab6cba14da6345b5ac3a590fca5"
  ],
  "scripts/migrate_context.py": [
    "0f28a7d380e8eaff6345a7de85e35008473e1e831e53b3d6de59631d4c64294b",
    "199062a3db3c03bf173c319e127304b7cdb7d9e519578c6b2ed3c8e943b85b09",
    "2b8ad6b19f9c765dafc150042f17e03daec3202b596f91cd1f22623324d1e285",
    "2d980376190941cbb009a3543820a9aa33b542c5903045ae4086118cc0ba653d",
    "2d984febcbd414a9c0c24eafa0a079b5392349e3965ac55954573576aa965eb6",
    "4d53ee694b0a341cb49a9d6288a8ccbfb69afa6aa2038085defc8c79e001ff35",
    "526caccc0cc808d4b54610ccc56fcd230027b2015e80d763b1f675802a4b3051",
    "74c2a244cbc895032e4db27b86c923d8c141fcc2b609a54a4ffce392b5855ab7",
    "886009e8d7d33b00bdda57a25afcbf0db89661b167b183bf7c6ccd15887d9072",
    "8d63d59e24da6ba365b2b09e2294aed5c1c745f3ede15bb17db9c21c841a81d5",
    "aef3bbaeab99ec3ccefbd13d3afc4791cd797f9a4c9dcf23463c7781fdb3eb9b"
  ],
  "scripts/upgrade_project_rules.py": [
    "c5afacea1cb07a5e1160daf53646c1d44dbee57e2c34435fc1e66b6c09a1172d"
  ],
  "scripts/upgrade_formal_source.py": [
    "304ecc26666def75f25ce4711251ba54022c27f68c00c9224456a9c5c7d13910"
  ],
  "scripts/sync_requirement_status.py": [
    "0e7fb29ad9da7368d5928786710bb2c30ebacd42c48e6b3039d077628fa164e2",
    "c543c95129c245e2be4872f1e51d1e2de1a1b57555af6abad5d71770ecf4877f"
  ],
  "scripts/create_requirement.py": [
    "e9671c5af6b00cd8e61ceac459f8a95fa834bdb933f4f336ac45964471e5fc79",
    "f35b268235d8ff5d5d3cce9c775e70017325233af7793e03e16c87e0d1b00a9f"
  ]
};
