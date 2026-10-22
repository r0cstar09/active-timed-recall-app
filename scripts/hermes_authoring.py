#!/usr/bin/env python3
"""Fail-closed bridge from maintenance tools to Hermes authoring.

The backend checkout is selected only from SPANISH_AUTHORING_BACKEND_DIR or the
stable application symlink.  This module deliberately has no HTTP/proxy or
legacy-checkout fallback.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

DEFAULT_BACKEND_DIR = Path("/home/rootadmin/hermes-spanish/current")
_FORBIDDEN_ROUTE_WORDS = ("google", "gemini", "vertex")


def exclusion_context(previous: list[dict[str, Any]]) -> str:
    """Give later batches the actual earlier content, not only new IDs."""
    return "\nDo not repeat these already accepted English meanings or Spanish answers:\n" + json.dumps(
        [{key: item[key] for key in ("prompt_en", "expected_es")} for item in previous],
        ensure_ascii=False,
    )


def duplicate_errors(items: Any, previous: list[dict[str, Any]]) -> list[str]:
    if not isinstance(items, list):
        return ["response is not an array"]
    errors = []
    for key in ("prompt_en", "expected_es"):
        normalize = lambda value: re.sub(r"\s+", " ", value).strip().casefold()
        seen = {normalize(item[key]) for item in previous}
        for item in items:
            value = normalize(item[key])
            if value in seen:
                errors.append(f"{item['id']}: duplicate {key}")
            seen.add(value)
    return errors


def backend_dir_from_env() -> Path:
    configured = os.environ.get("SPANISH_AUTHORING_BACKEND_DIR")
    return Path(configured).expanduser() if configured else DEFAULT_BACKEND_DIR


def _load_backend_module(backend_dir: Path) -> ModuleType:
    directory = backend_dir.expanduser().resolve()
    module_path = directory / "content_generation.py"
    if not module_path.is_file():
        raise RuntimeError(
            f"Hermes authoring backend is unavailable: {module_path} does not exist"
        )

    # content_generation imports sibling config/llm modules by their top-level
    # names. Refuse an already-loaded module from a different checkout rather
    # than silently mixing routes.
    for dependency in ("config", "llm"):
        loaded = sys.modules.get(dependency)
        loaded_file = getattr(loaded, "__file__", None) if loaded else None
        if loaded_file and Path(loaded_file).resolve().parent != directory:
            raise RuntimeError(
                f"cannot load Hermes authoring backend: {dependency} is already "
                f"loaded from {loaded_file}"
            )

    key = hashlib.sha256(str(module_path).encode("utf-8")).hexdigest()[:12]
    name = f"_spanish_maintenance_content_generation_{key}"
    cached = sys.modules.get(name)
    if cached is not None:
        return cached

    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import Hermes authoring backend from {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    sys.path.insert(0, str(directory))
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    finally:
        try:
            sys.path.remove(str(directory))
        except ValueError:
            pass
    return module


def validate_provenance(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise RuntimeError("Hermes authoring provenance must be an object")
    result = {key: str(value.get(key, "")).strip() for key in ("backend", "provider", "model")}
    if result["backend"] != "hermes":
        raise RuntimeError(f"authoring backend must be hermes, got {result['backend']!r}")
    if not result["provider"] or not result["model"]:
        raise RuntimeError("Hermes authoring provider/model provenance must not be blank")
    route_text = f"{result['provider']} {result['model']}".lower()
    if any(word in route_text for word in _FORBIDDEN_ROUTE_WORDS):
        raise RuntimeError("Google-family providers/models are forbidden for curriculum authoring")
    return result


class HermesAuthoring:
    """Small injectable adapter around backend content_generation."""

    def __init__(
        self,
        backend_dir: str | Path | None = None,
        *,
        module: ModuleType | Any | None = None,
    ) -> None:
        self.backend_dir = Path(backend_dir) if backend_dir is not None else backend_dir_from_env()
        self._module = module if module is not None else _load_backend_module(self.backend_dir)
        for attribute in ("generate_json", "provenance", "route"):
            if not callable(getattr(self._module, attribute, None)):
                raise RuntimeError(f"authoring backend lacks callable {attribute}()")
        self._provenance = validate_provenance(self._module.provenance())
        route = self._module.route()
        if not isinstance(route, tuple) or len(route) != 2 or str(route[0]) != "hermes":
            raise RuntimeError(f"invalid Hermes authoring route: {route!r}")
        if str(route[1]).strip() != self._provenance["model"]:
            raise RuntimeError("authoring route model disagrees with provenance")

    def provenance(self) -> dict[str, str]:
        return dict(self._provenance)

    def cache_namespace(self) -> str:
        route = ":".join(self._provenance[key] for key in ("backend", "provider", "model"))
        readable = re.sub(r"[^a-z0-9._-]+", "-", route.lower()).strip("-")[:72]
        digest = hashlib.sha256(route.encode("utf-8")).hexdigest()[:12]
        return f"{readable}-{digest}"

    def generate_json(
        self,
        prompt: str,
        *,
        temperature: float = 0.0,
        max_output_tokens: int = 8192,
        timeout: float | None = None,
    ) -> Any:
        kwargs: dict[str, Any] = {
            "temperature": temperature,
            "max_output_tokens": max_output_tokens,
            "strict_json": True,
        }
        if timeout is not None:
            kwargs["timeout"] = timeout
        return self._module.generate_json(prompt, **kwargs)
