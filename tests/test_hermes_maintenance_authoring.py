#!/usr/bin/env python3
"""Offline tests for Hermes-only curriculum maintenance authoring."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import sys
import tempfile
import types
import unittest
from collections import Counter
from pathlib import Path
from typing import Any
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


def load_script(name: str):
    path = SCRIPTS / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"test_{name}", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BRIDGE = load_script("hermes_authoring")
USAGE = load_script("generate_ser_usage_bank_llm")
LEVELED = load_script("generate_ser_leveled_usage_bank")
C1 = load_script("expand_spanish_c1_lessons")
REVIEW = load_script("review_ser_usage_bank_llm_text")


class FakeAuthorer:
    def __init__(self) -> None:
        self.calls: list[str] = []

    @staticmethod
    def provenance() -> dict[str, str]:
        return {"backend": "hermes", "provider": "openai-codex", "model": "gpt-test"}

    @staticmethod
    def cache_namespace() -> str:
        return "hermes-openai-codex-gpt-test-route"

    def generate_json(self, prompt: str, **_: Any) -> Any:
        self.calls.append(prompt)
        ids = re.search(r"ser-usage-(\d{3}).*?(?:through|to) ser-usage-(\d{3})", prompt, re.S)
        if not ids:
            raise AssertionError("test authorer could not find requested ID range")
        start, end = map(int, ids.groups())
        batch_match = re.search(r'"batch":(\d+)', prompt)
        level_match = re.search(r'"level":"([^"]+)"', prompt)
        batch = int(batch_match.group(1)) if batch_match else (start - 1) // 50 + 1
        return [self._item(index, batch, level_match.group(1) if level_match else None) for index in range(start, end + 1)]

    @staticmethod
    def _item(index: int, batch: int, level: str | None) -> dict[str, Any]:
        item: dict[str, Any] = {
            "id": f"ser-usage-{index:03d}",
            "verb": "ser",
            "batch": batch,
            "batch_size": 50,
            "tense": "Present",
            "mood": "indicative/conditional",
            "difficulty": "A2" if level else "C1",
            "construction": f"identity {index}",
            "prompt_en": f"Say: Item number {index} identifies a distinct example.",
            "expected_es": f"Es el ejemplo distinto número {index}.",
            "acceptable_answer_pattern": None,
            "target_vocabulary": [f"ejemplo-{index}"],
            "grading_notes": "Grade the required SER use.",
            "correction_hint": "Use SER for identity.",
        }
        if level is not None:
            item["level"] = level
        return item


class BadAuthorer(FakeAuthorer):
    def generate_json(self, prompt: str, **kwargs: Any) -> Any:
        self.calls.append(prompt)
        return []


class C1Authorer:
    def __init__(self, bad: bool = False) -> None:
        self.bad = bad
        self.calls: list[str] = []

    @staticmethod
    def provenance() -> dict[str, str]:
        return {"backend": "hermes", "provider": "openai-codex", "model": "gpt-test"}

    def generate_json(self, prompt: str, **_: Any) -> Any:
        self.calls.append(prompt)
        if self.bad:
            return {"sections": {}}
        match = re.search(r"Author lesson (\d+)", prompt)
        assert match is not None
        number = int(match.group(1))
        difficulty = C1.outline_for(number)[0]
        sections: dict[str, Any] = {}
        for name in C1.REQUIRED_SECTIONS:
            count = C1.SECTION_COUNTS[difficulty][name]
            sections[name] = {
                "title": f"Hermes {name} {number}",
                "instructions": f"Complete the {name} work for lesson {number}.",
                "prompts": [f"[{number} · {name} {i}] Produce original response {i}." for i in range(count)],
                "answers": [] if name == "writing" else [f"Modelo {number}-{name}-{i}: Es una respuesta original." for i in range(count)],
            }
        return {
            "naturalExamples": [f"El ejemplo {number}-{i} es original." for i in range(4)],
            "sections": sections,
            "commonErrors": [
                {"mistake": f"Error {number}-{i}", "why_it_happens": "Transferencia literal.", "correct_spanish": f"La corrección {number}-{i} es natural."}
                for i in range(3)
            ],
        }


class ReviewAuthorer:
    def __init__(self, fail_batch: int | None = None) -> None:
        self.fail_batch = fail_batch
        self.calls: list[tuple[str, dict[str, Any]]] = []

    @staticmethod
    def provenance() -> dict[str, str]:
        return {"backend": "hermes", "provider": "openai-codex", "model": "gpt-test"}

    def generate_json(self, prompt: str, **kwargs: Any) -> Any:
        self.calls.append((prompt, kwargs))
        match = re.search(r"batch (\d+)", prompt)
        assert match is not None
        batch = int(match.group(1))
        if batch == self.fail_batch:
            return {"wrong": "shape"}
        return {"report": f"FIXES: NONE\nOVERALL: Batch {batch} is suitable."}


def valid_existing_lesson(number: int) -> dict[str, Any]:
    sections = {
        name: {
            "title": name,
            "instructions": "Saved instruction.",
            "prompts": [f"saved {number} {name}"],
            "answers": [] if name == "writing" else [f"saved answer {number} {name}"],
        }
        for name in C1.REQUIRED_SECTIONS
    }
    return {
        "id": f"lesson-{number}", "number": number, "title": f"Saved {number}",
        "difficulty": "B2", "patternId": f"SAVED_{number}", "tags": ["saved"],
        "targetPattern": "saved", "englishTrap": "saved", "spanishLogic": "saved",
        "formula": ["saved"], "naturalExamples": ["Es un ejemplo guardado."],
        "sections": sections,
        "commonErrors": [{"mistake": "saved", "why_it_happens": "saved", "correct_spanish": "saved"}],
    }


class BridgeTests(unittest.TestCase):
    def test_bridge_loads_selected_backend_and_forces_strict_json(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermes-authoring-backend-") as tmp:
            backend = Path(tmp)
            (backend / "content_generation.py").write_text(
                "def route(model=None): return ('hermes', 'gpt-test')\n"
                "def provenance(model=None): return {'backend':'hermes','provider':'openai-codex','model':'gpt-test'}\n"
                "def generate_json(prompt, **kwargs): return {'prompt': prompt, 'kwargs': kwargs}\n",
                encoding="utf-8",
            )
            authorer = BRIDGE.HermesAuthoring(backend)
            value = authorer.generate_json("author", temperature=0.4)
            self.assertEqual(authorer.provenance()["backend"], "hermes")
            self.assertTrue(value["kwargs"]["strict_json"])
            self.assertIn("gpt-test", authorer.cache_namespace())

    def test_bridge_fails_closed_without_backend_or_for_google_route(self) -> None:
        with tempfile.TemporaryDirectory(prefix="missing-hermes-backend-") as tmp:
            with self.assertRaisesRegex(RuntimeError, "unavailable"):
                BRIDGE.HermesAuthoring(Path(tmp) / "missing")
        module = types.SimpleNamespace(
            route=lambda: ("hermes", "gemini-test"),
            provenance=lambda: {"backend": "hermes", "provider": "google", "model": "gemini-test"},
            generate_json=lambda *_args, **_kwargs: {},
        )
        with self.assertRaisesRegex(RuntimeError, "forbidden"):
            BRIDGE.HermesAuthoring(module=module)

    def test_no_legacy_proxy_or_google_client_in_executable_scripts(self) -> None:
        for name in (
            "hermes_authoring.py", "generate_ser_usage_bank_llm.py",
            "generate_ser_leveled_usage_bank.py", "expand_spanish_c1_lessons.py",
            "review_ser_usage_bank_llm_text.py",
        ):
            text = (SCRIPTS / name).read_text(encoding="utf-8")
            self.assertNotIn("34.24.121.154", text)
            self.assertNotIn("SPANISH_LLM_PROXY", text)
            self.assertNotRegex(text, r"\brequests\.(post|get)\b")


class ImportSafetyTests(unittest.TestCase):
    def test_imports_do_not_change_saved_content_or_reports(self) -> None:
        tracked = [
            ROOT / "src/data/generated/c1_verb_usage_banks.json",
            ROOT / "src/data/generated/fuzzy_lessons.json",
            ROOT / "reports/ser_usage_llm_generation/llm_quality_review_text.md",
        ]
        before = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in tracked if path.exists()}
        for name in ("generate_ser_usage_bank_llm", "generate_ser_leveled_usage_bank", "expand_spanish_c1_lessons", "review_ser_usage_bank_llm_text"):
            load_script(name + "_import_probe") if False else load_script(name)
        after = {path: hashlib.sha256(path.read_bytes()).hexdigest() for path in tracked if path.exists()}
        self.assertEqual(before, after)


class UsageBankTests(unittest.TestCase):
    @staticmethod
    def write_vocab(path: Path) -> None:
        rows = ["spanish,english,domain,collocations"]
        rows.extend(f"palabra{i},word{i},domain{i % 12},usar palabra{i}" for i in range(600))
        path.write_text("\n".join(rows) + "\n", encoding="utf-8")

    def test_c1_bank_is_500_deduped_route_namespaced_and_preserves_other_sources(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermes-usage-test-") as tmp:
            root = Path(tmp)
            out, vocab, reports = root / "bank.json", root / "vocab.csv", root / "reports"
            old_other = {"verb": "tener", "prompts": [{"id": "saved"}], "source": "saved-source"}
            old_advanced = {"verb": "ser_advanced", "prompts": [{"id": "advanced-saved"}]}
            old_generation = {"model": "historical-google-model", "note": "saved provenance"}
            out.write_text(json.dumps({"source": "old", "generation": old_generation, "verbs": {"tener": old_other, "ser_advanced": old_advanced}}), encoding="utf-8")
            self.write_vocab(vocab)
            legacy = reports / "batch_01_chunk_1_parsed.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text("[]", encoding="utf-8")
            authorer = FakeAuthorer()
            report = USAGE.generate(authorer=authorer, vocab_path=vocab, out_path=out, report_dir=reports, replace_ser=True)
            bank = json.loads(out.read_text(encoding="utf-8"))
            prompts = bank["verbs"]["ser"]["prompts"]
            self.assertEqual(report["prompts"], 500)
            self.assertEqual(len(authorer.calls), 50)
            self.assertEqual(len({item["prompt_en"] for item in prompts}), 500)
            self.assertEqual(len({item["expected_es"] for item in prompts}), 500)
            self.assertEqual(bank["verbs"]["tener"], old_other)
            self.assertEqual(bank["verbs"]["ser_advanced"], old_advanced)
            self.assertEqual(bank["generation"], old_generation)
            self.assertEqual(bank["verbs"]["ser"]["generation"]["backend"], "hermes")
            self.assertEqual(bank["last_generation"]["provider"], "openai-codex")
            self.assertEqual(bank["last_generation"]["scope"], "ser")
            self.assertTrue((reports / "cache" / authorer.cache_namespace()).is_dir())

    def test_c1_bank_default_preserves_and_invalid_generation_does_not_write_main_output(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermes-usage-fail-") as tmp:
            root = Path(tmp)
            out, vocab = root / "bank.json", root / "vocab.csv"
            original = json.dumps({"verbs": {"ser": {"prompts": [{"id": "saved"}]}}})
            out.write_text(original, encoding="utf-8")
            self.write_vocab(vocab)
            authorer = FakeAuthorer()
            result = USAGE.generate(authorer=authorer, vocab_path=vocab, out_path=out, report_dir=root / "reports")
            self.assertEqual(result["status"], "preserved")
            self.assertEqual(authorer.calls, [])
            self.assertEqual(out.read_text(encoding="utf-8"), original)
            with self.assertRaises(ValueError):
                USAGE.generate(authorer=BadAuthorer(), vocab_path=vocab, out_path=out, report_dir=root / "bad-reports", replace_ser=True)
            self.assertEqual(out.read_text(encoding="utf-8"), original)

    def test_leveled_bank_contract_and_ser_advanced_preservation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermes-leveled-test-") as tmp:
            root = Path(tmp)
            out = root / "bank.json"
            old_ser = {"verb": "ser", "quality_note": "Original C1 bank", "prompts": [{"id": "old-c1"}]}
            old_other = {"verb": "ir", "prompts": [{"id": "saved-ir"}]}
            out.write_text(json.dumps({"verbs": {"ser": old_ser, "ir": old_other}}), encoding="utf-8")
            authorer = FakeAuthorer()
            LEVELED.generate_leveled_bank(
                authorer=authorer, out_path=out, report_path=root / "report.json",
                cache_root=root / "cache", replace_ser=True,
            )
            bank = json.loads(out.read_text(encoding="utf-8"))
            prompts = bank["verbs"]["ser"]["prompts"]
            self.assertEqual(len(prompts), 500)
            self.assertEqual(Counter(item["level"] for item in prompts), Counter({"easy": 200, "medium": 150, "past": 75, "advanced_intro": 75}))
            self.assertEqual(Counter(item["batch"] for item in prompts), Counter({index: 50 for index in range(1, 11)}))
            self.assertEqual(len({item["prompt_en"] for item in prompts}), 500)
            self.assertEqual(bank["verbs"]["ir"], old_other)
            self.assertEqual(bank["verbs"]["ser_advanced"]["prompts"], old_ser["prompts"])
            self.assertEqual(bank["generation"]["backend"], "hermes")


class ChunkDedupeTests(unittest.TestCase):
    def test_repeated_earlier_answer_is_repaired_before_continuing(self):
        class DuplicateOnce(FakeAuthorer):
            def generate_json(self, prompt, **kwargs):
                result = super().generate_json(prompt, **kwargs)
                if len(self.calls) == 2:
                    result[0]["prompt_en"] = "Say: Item number 1 identifies a distinct example."
                    result[0]["expected_es"] = "Es el ejemplo distinto número 1."
                return result
        for mode in ["c1", "leveled"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="hermes-dedupe-") as tmp:
                root = Path(tmp)
                authorer = DuplicateOnce()
                if mode == "c1":
                    UsageBankTests.write_vocab(root / "vocab.csv")
                    USAGE.generate(authorer=authorer, vocab_path=root / "vocab.csv", out_path=root / "bank.json", report_dir=root / "reports")
                else:
                    LEVELED.generate_leveled_bank(authorer=authorer, out_path=root / "bank.json", report_path=root / "report.json", cache_root=root / "cache")
                self.assertIn("Es el ejemplo distinto número 1.", authorer.calls[1])
                self.assertIn("duplicate expected_es", authorer.calls[2])
                items = json.loads((root / "bank.json").read_text())["verbs"]["ser"]["prompts"]
                self.assertEqual(len({x["expected_es"] for x in items}), 500)


class CurriculumAndReviewTests(unittest.TestCase):
    def test_c1_replaces_only_selected_lesson_and_preserves_saved_source(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermes-c1-test-") as tmp:
            root = Path(tmp)
            lesson_path, report_path = root / "lessons.json", root / "report.md"
            saved81, saved82 = valid_existing_lesson(81), valid_existing_lesson(82)
            historical_authoring = {"model": "historical-model"}
            lesson_path.write_text(json.dumps({"sourceRepo": "saved/source", "authoring": historical_authoring, "count": 2, "lessons": [saved82, saved81]}), encoding="utf-8")
            authorer = C1Authorer()
            result = C1.expand_curriculum(
                authorer=authorer, lesson_path=lesson_path, report_path=report_path,
                replace_generated=True, lesson_numbers=[82],
            )
            data = json.loads(lesson_path.read_text(encoding="utf-8"))
            by_number = {item["number"]: item for item in data["lessons"]}
            self.assertEqual(by_number[81], saved81)
            self.assertEqual(by_number[82]["id"], "lesson-82")
            self.assertEqual(set(by_number[82]["sections"]), set(C1.REQUIRED_SECTIONS))
            self.assertEqual(by_number[82]["sections"]["writing"]["answers"], [])
            self.assertEqual(data["authoring"], historical_authoring)
            self.assertEqual(data["last_authoring"]["lesson_numbers"], [82])
            self.assertEqual(by_number[82]["authoring"]["backend"], "hermes")
            self.assertEqual(result["provenance"]["backend"], "hermes")
            self.assertEqual(len(authorer.calls), 1)

    def test_c1_default_and_validation_failure_leave_saved_file_unchanged(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermes-c1-fail-") as tmp:
            root = Path(tmp)
            path = root / "lessons.json"
            path.write_text(json.dumps({"count": 2, "lessons": [valid_existing_lesson(82), valid_existing_lesson(81)]}), encoding="utf-8")
            original = path.read_bytes()
            preserve_authorer = C1Authorer()
            result = C1.expand_curriculum(authorer=preserve_authorer, lesson_path=path, report_path=root / "report.md")
            self.assertEqual(result["status"], "preserved")
            self.assertEqual(preserve_authorer.calls, [])
            with self.assertRaises(ValueError):
                C1.expand_curriculum(authorer=C1Authorer(bad=True), lesson_path=path, report_path=root / "bad-report.md", replace_generated=True, lesson_numbers=[82])
            self.assertEqual(path.read_bytes(), original)
            self.assertFalse((root / "bad-report.md").exists())

    def test_review_uses_strict_json_report_and_writes_only_after_all_batches(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hermes-review-test-") as tmp:
            root = Path(tmp)
            bank_path, out = root / "bank.json", root / "review.md"
            prompts = [FakeAuthorer._item(index, (index - 1) // 2 + 1, None) for index in range(1, 5)]
            bank_path.write_text(json.dumps({"verbs": {"ser": {"prompts": prompts}}}), encoding="utf-8")
            authorer = ReviewAuthorer()
            result = REVIEW.review_bank(authorer=authorer, bank_path=bank_path, out_path=out)
            text = out.read_text(encoding="utf-8")
            self.assertEqual(result["batches"], 2)
            self.assertIn("provider: openai-codex", text)
            self.assertTrue(all(call[1]["max_output_tokens"] == 4000 for call in authorer.calls))
            original = b"existing review\n"
            out.write_bytes(original)
            with self.assertRaises(ValueError):
                REVIEW.review_bank(authorer=ReviewAuthorer(fail_batch=2), bank_path=bank_path, out_path=out)
            self.assertEqual(out.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
