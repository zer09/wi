"""Synthetic tests; these strings are fixture inputs, not checkout dependencies."""
import unittest
from check_references import audit


class ReferenceChecks(unittest.TestCase):
    def test_missing_inline_and_reference_links(self):
        files = {"README.md": "[one](gone.md)\n[two][ref]\n[ref]: other.md\n"}
        errors, _ = audit(files)
        self.assertEqual(len(errors), 2)
        self.assertTrue(any("gone.md" in error for error in errors))
        self.assertTrue(any("other.md" in error for error in errors))

    def test_missing_definition(self):
        errors, _ = audit({"README.md": "[label][undefined]"})
        self.assertEqual(len(errors), 1)
        self.assertIn("undefined Markdown label", errors[0])

    def test_heading_fragments_duplicates_and_fenced_examples(self):
        files = {"README.md": "# Hello `World`\n# Hello World\n[x](#hello-world-1)\n"
                 "```md\n[not a link](missing.md)\n```\n[y](#absent)\n"}
        errors, _ = audit(files)
        self.assertEqual(len(errors), 1)
        self.assertIn("missing heading", errors[0])

    def test_relative_encoded_paths_and_directories(self):
        files = {"README.md": "[guide](docs/a%20b.md#title) [dir](docs/)",
                 "docs/a b.md": "# Title\n[home](../README.md)"}
        self.assertEqual(audit(files)[0], [])

    def test_archive_urls_are_not_current_checkout_dependencies(self):
        files = {"README.md": "[old](https://example.invalid/commit/removed.md)"}
        errors, counts = audit(files)
        self.assertEqual(errors, [])
        self.assertEqual(counts["external-not-checked"], 1)

    def test_rust_includes(self):
        # Split fixture strings so this test does not claim actual dependencies.
        target = '../' + 'docs/' + 'gone.md'
        source = 'include_str!' + '(' + repr(target) + ')'
        source = source.replace("'", '"')
        errors, _ = audit({"src/lib.rs": source})
        self.assertTrue(any("rust-include" in error for error in errors))

    def test_module_urls_and_literal_document_arrays(self):
        target = '../' + 'docs/' + 'gone.md'
        source = 'new ' + 'URL(' + repr(target) + ', import.meta.url);'
        source += "const docs = ['docs/" + "old.md'];"
        errors, _ = audit({"scripts/test.mjs": source})
        self.assertTrue(any("module-url" in error for error in errors))
        self.assertTrue(any("old.md" in error for error in errors))

    def test_typescript_js_specifier_resolves_to_source(self):
        source = 'import { x } ' + 'from "./other.js";'
        files = {"web/src/main.ts": source, "web/src/other.ts": "export const x = 1;"}
        self.assertEqual(audit(files)[0], [])
        del files["web/src/other.ts"]
        self.assertEqual(len(audit(files)[0]), 1)

    def test_import_does_not_resolve_to_unrelated_same_basename(self):
        source = 'import ' + '"./other.mjs";'
        errors, _ = audit({"scripts/main.mjs": source, "web/other.mjs": ""})
        self.assertEqual(len(errors), 1)

    def test_concrete_backtick_paths_and_template_exclusions(self):
        text = '`src/missing.rs:12-15` `src/**/tests` `sessions/<id>/data`'
        errors, _ = audit({"docs/guide.md": text})
        self.assertEqual(len(errors), 1)
        self.assertIn("missing.rs", errors[0])

    def test_no_tests_directory_exclusion(self):
        source = 'new ' + 'URL("../absent.json", import.meta.url)'
        errors, _ = audit({"tests/regression.mjs": source})
        self.assertEqual(len(errors), 1)

    def test_old_document_shape_is_rejected_then_real_target_passes(self):
        target = '/'.join(['docs', 'removed', 'POLICY.md'])
        source = 'const files = [' + repr(target) + '];'
        files = {"scripts/fixture.mjs": source}
        self.assertEqual(len(audit(files)[0]), 1)
        files[target] = "# Retained policy\n"
        self.assertEqual(audit(files)[0], [])


if __name__ == "__main__":
    unittest.main()
