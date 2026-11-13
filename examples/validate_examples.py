#!/usr/bin/env python3
"""校验交接样例；不执行 Agent，也不修改样例文件。

需要 Python 包 jsonschema；运行：python examples/validate_examples.py。
标准 Schema、跨对象引用、源码锚点各自执行，不能互相代替。
本脚本的符号范围仅针对已提供的极小 C fixture，不是通用 C 解析器。
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path, PurePosixPath

try:
    from jsonschema import Draft202012Validator
except ImportError as exc:
    raise SystemExit("缺少 jsonschema：请在开发校验环境安装后再执行；本次未完成 Schema 校验。") from exc


BASE = Path(__file__).resolve().parent


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def unique_index(items: list, key: str) -> dict:
    result = {item[key]: item for item in items}
    require(len(result) == len(items), f"{key} 不唯一")
    return result


def main() -> None:
    request = load(BASE / "run-request.json")
    result = load(BASE / "analysis-result.json")
    manifest = load(BASE / "source-snapshot.json")
    schema = load(BASE.parent / "contracts" / "analysis-result.schema.json")

    Draft202012Validator.check_schema(schema)
    failures = sorted(
        Draft202012Validator(schema).iter_errors(result),
        key=lambda error: str(list(error.absolute_path)),
    )
    require(not failures, "Schema 校验失败：" + "；".join(
        f"{list(error.absolute_path)}: {error.message}" for error in failures
    ))

    keys = {
        "project_id", "feature_id", "scenario_id", "question_revision_id",
        "source_snapshot_id", "run_id",
    }
    require(set(request["binding"]) == keys, "请求绑定字段不完整或包含额外字段")
    require(request["binding"] == result["binding"], "请求与结果的冻结绑定不同")
    require(result["binding"]["source_snapshot_id"] == manifest["source_snapshot_id"]
            == "snapshot-demo-a", "快照标识不匹配")
    require(all(value["fictional"] is True for value in [request, result, manifest]),
            "所有样例必须明确 fictional=true")
    require(request["provider"]["provider_id"] == result["provider"]["provider_id"]
            == "demo", "样例不能冒充真实供应商运行")
    require(request["provider"]["connection_id"] == result["provider"]["connection_id"],
            "请求与结果的连接不同")
    require(request["task_kind"] == "analysis" and
            request["workspace"]["access_mode"] == "read_only", "样例必须只读")
    require(request["policy"]["respect_workspace_rules"] is True and
            request["policy"]["command_transport"] == "argv_stdin", "任务安全合同不匹配")

    nodes = unique_index(result["nodes"], "node_id")
    edges = unique_index(result["edges"], "edge_id")
    claims = unique_index(result["claims"], "claim_id")
    evidence = unique_index(result["evidence"], "evidence_id")
    gaps = unique_index(result["gaps"], "gap_id")
    io = unique_index([
        item for node in result["nodes"]
        for item in [*node["inputs"], *node["outputs"]]
    ], "io_id")
    all_ids = [item for group in [nodes, edges, claims, evidence, gaps, io] for item in group]
    require(len(set(all_ids)) == len(all_ids), "不同对象类别出现相同 ID")

    indexes = {
        "claim_ids": claims, "evidence_ids": evidence, "node_ids": nodes,
        "edge_ids": edges, "io_ids": io, "related_node_ids": nodes,
    }

    def check_references(value: object) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                require(re.fullmatch(r"[a-z][a-z0-9_]*", key) is not None,
                        f"序列化字段不是 snake_case：{key}")
                if key in indexes:
                    for reference in item:
                        require(reference in indexes[key], f"悬空引用 {key}: {reference}")
                elif key in {"source_node_id", "target_node_id", "parent_node_id"}:
                    require(item in nodes, f"关系端点不存在：{item}")
                elif key == "related_call_edge_id":
                    require(item in edges, f"对应调用关系不存在：{item}")
                check_references(item)
        elif isinstance(value, list):
            for item in value:
                check_references(item)

    check_references(result)
    check_references(request)
    for node in nodes.values():
        current = node
        seen = set()
        while "parent_node_id" in current:
            require(current["node_id"] not in seen, f"节点聚合存在循环：{node['node_id']}")
            seen.add(current["node_id"])
            current = nodes[current["parent_node_id"]]
        context = node["execution_context"]
        if context["status"] == "source_supported":
            require(any(claims[cid]["status"] == "source_supported"
                        and claims[cid]["evidence_ids"] for cid in context["claim_ids"]),
                    f"执行上下文缺少源码断言：{node['node_id']}")
        require("execution_episode_id" not in node,
                "当前静态 fixture 未提供运行追踪，不能伪造执行轮次")
    for edge in edges.values():
        for cid in edge["claim_ids"]:
            require(edge["edge_id"] in claims[cid]["targets"]["edge_ids"],
                    f"关系断言的目标不含该关系：{edge['edge_id']} / {cid}")
        if edge["status"] == "source_supported":
            require(any(claims[cid]["status"] == "source_supported"
                        and claims[cid]["evidence_ids"] for cid in edge["claim_ids"]),
                    f"source_supported 关系缺少有源码依据的断言：{edge['edge_id']}")
        if "related_call_edge_id" in edge:
            call = edges[edge["related_call_edge_id"]]
            require(edge["kind"] == "return" and call["kind"] == "sync_call",
                    "返回配对只能关联同步调用")
            require(edge["source_node_id"] == call["target_node_id"] and
                    edge["target_node_id"] == call["source_node_id"],
                    f"返回关系与对应调用方向不匹配：{edge['edge_id']}")

    root = (BASE / manifest["fixture_root"]).resolve()
    files = unique_index(manifest["files"], "path")
    contents: dict[str, list[str]] = {}
    for rel, entry in files.items():
        path = PurePosixPath(rel)
        require(not path.is_absolute() and str(path) == rel and
                ".." not in path.parts and "\\" not in rel, f"路径不规范：{rel}")
        actual = (root / rel).resolve()
        require(actual.is_relative_to(root), f"路径或软链接逃出快照根：{rel}")
        raw = actual.read_bytes()
        require(hashlib.sha256(raw).hexdigest() == entry["content_sha256"],
                f"文件 SHA-256 不一致：{rel}")
        contents[rel] = raw.decode("utf-8").splitlines()
        require(len(contents[rel]) == entry["line_count"], f"行数不一致：{rel}")
    actual_files = {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}
    require(actual_files == set(files), "fixture 实际文件与 manifest 文件列表不同")

    def check_range(item: dict) -> None:
        require(item["path"] in files, f"锚点文件不在快照中：{item['path']}")
        require(1 <= item["line_start"] <= item["line_end"] <=
                files[item["path"]]["line_count"], f"行范围无效：{item}")

    symbols = unique_index(manifest["symbols"], "symbol_id")
    for symbol in symbols.values():
        require(symbol["symbol_id"] == "c:" + symbol["name"], "C fixture 符号 ID 不匹配")
        for location in [*symbol["declarations"], *symbol["definitions"]]:
            check_range(location)
            snippet = "\n".join(contents[location["path"]][
                location["line_start"] - 1:location["line_end"]
            ])
            require(re.search(r"\b" + re.escape(symbol["name"]) + r"\s*\(", snippet)
                    is not None, f"符号名称不在声明/定义锚点中：{symbol['name']}")

    for item in evidence.values():
        check_range(item)
        require(item["source_snapshot_id"] == manifest["source_snapshot_id"],
                f"证据引用了不同快照：{item['evidence_id']}")
        require(item["content_sha256"] == files[item["path"]]["content_sha256"],
                f"证据与文件哈希不同：{item['evidence_id']}")
        if "symbol_id" in item:
            require(item["symbol_id"] in symbols, f"符号 ID 不存在：{item['symbol_id']}")
            symbol = symbols[item["symbol_id"]]
            if item["role"] == "definition":
                locations = symbol["definitions"]
            elif item["role"] == "declaration":
                locations = symbol["declarations"]
            else:
                locations = [*symbol["definitions"], *symbol["declarations"]]
            # 声明证据可包含紧邻注释；其范围至少必须包含正式声明行。
            require(any(loc["path"] == item["path"] and (
                loc["line_start"] <= item["line_start"] <= item["line_end"] <= loc["line_end"]
                or item["role"] == "declaration" and
                item["line_start"] <= loc["line_start"] <= loc["line_end"] <= item["line_end"]
            ) for loc in locations), f"证据范围不对应声明/定义符号：{item['evidence_id']}")

    for omitted in manifest["omitted_symbols"]:
        require(omitted["symbol_id"] in symbols and
                not symbols[omitted["symbol_id"]]["definitions"], "故意缺失的函数出现了定义")

    print(json.dumps({
        "schema_draft_2020_12": "passed",
        "binding_and_references": "passed",
        "source_hashes_and_ranges": "passed",
        "fixture_symbol_ranges": "passed",
        "execution_context_parent_and_return_links": "passed",
        "counts": {"files": len(files), "nodes": len(nodes), "edges": len(edges),
                   "claims": len(claims), "evidence": len(evidence), "gaps": len(gaps)},
        "scope": "结构与锚点校验；不等于全局语义证明、真实 App 测试或供应商联调。",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
