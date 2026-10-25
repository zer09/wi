#!/usr/bin/env python3
"""Offline checks for explicit repository references; not a general code parser.

Scan every tracked text file. Check Markdown links/anchors, literal repository
Markdown paths in code, Rust includes, and relative JS/TS imports/module URLs.
External URLs, runtime-created paths and dynamically assembled paths are not
resolved. No source, fixture, test or historical directory is blanket-excluded.
"""
from __future__ import annotations

import posixpath
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import NamedTuple
from urllib.parse import unquote, urlsplit


# These two references have explicit build/install producers, not tracked inputs.
# Do not turn this into a directory wildcard: a misspelled sibling must still fail.
GENERATED = {
    ("scripts/cli_retest.mjs", "../target/debug/wi"): "cargo build",
    ("web/scripts/assets.mjs", "../node_modules/typescript/bin/tsc"): "npm ci in web",
}


class Reference(NamedTuple):
    source: str
    line: int
    target: str
    kind: str


def prose(text: str) -> str:
    """Blank fenced examples without changing line positions."""
    lines = text.splitlines(keepends=True)
    fence = None
    for i, line in enumerate(lines):
        match = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if fence:
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence):
                fence = None
            lines[i] = "\n" if line.endswith("\n") else ""
        elif match:
            fence = match[1]
            lines[i] = "\n" if line.endswith("\n") else ""
    return "".join(lines)


def anchors(text: str) -> set[str]:
    found, counts = set(), Counter()
    clean = prose(text)
    for title in re.findall(r"^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$", clean, re.M):
        title = re.sub(r"<[^>]*>", "", title).lower()
        slug = re.sub(r"[^\w\- ]", "", title).replace(" ", "-")
        count = counts[slug]
        counts[slug] += 1
        found.add(f"{slug}-{count}" if count else slug)
    found.update(re.findall(r'(?:id|name)=[\'\"]([^\'\"]+)[\'\"]', clean))
    return found


def references(path: str, text: str) -> list[Reference]:
    refs: list[Reference] = []

    def add(target: str, offset: int, kind: str, source: str = text) -> None:
        refs.append(Reference(path, source.count("\n", 0, offset) + 1, target, kind))

    if path.endswith(".md"):
        clean = prose(text)
        # Inline and image links, reference definitions, and local HTML links.
        for match in re.finditer(r'!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s()]+))(?:\s+[\'\"][^\n]*?[\'\"])?\s*\)', clean):
            add(match[1] or match[2], match.start(), "markdown", clean)
        definitions = {}
        for match in re.finditer(r"^ {0,3}\[([^\]\n]+)\]:\s*<?([^\s>]+)>?", clean, re.M):
            definitions[match[1].strip().lower()] = match[2]
            add(match[2], match.start(), "markdown", clean)
        for match in re.finditer(r"\[([^\]\n]+)\]\[([^\]\n]*)\]", clean):
            label = (match[2] or match[1]).strip().lower()
            if label not in definitions:
                add(label, match.start(), "undefined-label", clean)
        for match in re.finditer(r'(?:href|src)=[\'\"]([^\'\"]+)[\'\"]', clean):
            add(match[1], match.start(), "markdown", clean)
        # Code-formatted concrete source paths are also documentation promises.
        for match in re.finditer(r"`((?:\.{1,2}/)?(?:src|scripts|tests|examples|docs|web|\.github)/[^`\s]+)`", clean):
            target = re.sub(r":\d+(?:[-–]\d+)?$", "", match[1])
            if not re.search(r"[*{}<>$]", target):
                add(target, match.start(), "source-path", clean)
    else:
        # Catches document paths stored in arrays/variables, not only direct reads.
        for match in re.finditer(r'''["'`]((?:\.{1,2}/)*(?:docs/)[A-Za-z0-9_./-]+\.md)["'`]''', text):
            add(match[1], match.start(), "document-literal")
    if path.endswith(".rs"):
        for match in re.finditer(r'include(?:_str|_bytes)?!\s*\(\s*(?:r\#*)?"([^"\n]+)"', text):
            add(match[1], match.start(), "rust-include")
    if path.endswith((".mjs", ".js", ".ts")):
        for match in re.finditer(r'''new\s+URL\(\s*["'](\.{1,2}/[^"'\n]+)["']\s*,\s*import\.meta\.url\s*\)''', text):
            add(match[1], match.start(), "module-url")
        for match in re.finditer(r'''(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}/[^"'\n]+)["']''', text):
            add(match[1], match.start(), "module-import")
    return refs


def audit(files: dict[str, str], tracked: set[str] | None = None) -> tuple[list[str], Counter]:
    tracked = set(files) if tracked is None else tracked
    directories = {"."}
    for path in tracked:
        parent = posixpath.dirname(path)
        while parent:
            directories.add(parent)
            parent = posixpath.dirname(parent)
    errors, counts = [], Counter()
    for path, text in sorted(files.items()):
        for ref in references(path, text):
            counts[ref.kind] += 1
            if (path, ref.target) in GENERATED and ref.kind == "module-url":
                counts["generated-not-checked"] += 1
                continue
            if ref.kind == "undefined-label":
                errors.append(f"{path}:{ref.line}: undefined Markdown label {ref.target!r}")
                continue
            url = urlsplit(ref.target)
            if url.scheme or url.netloc:
                counts["external-not-checked"] += 1
                continue
            target = unquote(url.path)
            if ref.kind in ("document-literal", "source-path") and not target.startswith("."):
                # Source paths in prose may be repo-relative or guide-relative.
                candidates = [target, posixpath.join(posixpath.dirname(path), target)]
            else:
                candidates = [posixpath.join(posixpath.dirname(path), target) if target else path]
            candidates = [posixpath.normpath(p) for p in candidates]
            if ref.kind == "module-import" and path.endswith(".ts"):
                candidates += [p[:-3] + ".ts" for p in candidates if p.endswith(".js")]
            valid = next((p for p in candidates if p in tracked or p in directories), None)
            if valid is None:
                errors.append(f"{path}:{ref.line}: missing {ref.kind} target {ref.target!r}")
            elif url.fragment and valid.endswith(".md") and valid in files:
                if unquote(url.fragment) not in anchors(files[valid]):
                    errors.append(f"{path}:{ref.line}: missing heading {ref.target!r}")
    return sorted(set(errors)), counts


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    try:
        listing = subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
        tracked = {p.decode("utf-8") for p in listing.split(b"\0") if p}
        if not tracked:
            raise ValueError("no tracked files")
        files, unavailable = {}, []
        for relative in sorted(tracked):
            path = root / relative
            # Never use an outside-repository symlink as a readable dependency.
            if not path.resolve().is_relative_to(root) or not path.is_file():
                unavailable.append(f"{relative}: tracked file missing or outside repository")
                continue
            data = path.read_bytes()
            if b"\0" in data:
                continue
            try:
                files[relative] = data.decode("utf-8")
            except UnicodeDecodeError:
                continue
        errors, counts = audit(files, tracked)
        errors += unavailable
    except (OSError, UnicodeError, ValueError, subprocess.SubprocessError) as error:
        print(f"reference check could not complete: {type(error).__name__}", file=sys.stderr)
        return 2
    print(f"Reference audit: {len(tracked)} tracked files, {len(files)} text files")
    for kind, count in sorted(counts.items()):
        print(f"  {kind}: {count}")
    for error in errors:
        print(error)
    print(f"Broken local references: {len(errors)}")
    print("Scope: explicit static local references; no external URL or dynamic-path guarantee.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
