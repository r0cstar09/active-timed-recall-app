#!/usr/bin/env python3
"""Offline lifecycle tests for the read-only browser QA proxy (no browser launch)."""
import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from urllib.parse import urlparse

source = ast.parse(Path(__file__).with_name('test_design_browser.py').read_text())
node = next(n for n in source.body if isinstance(n, ast.FunctionDef) and n.name == 'attach_read_only_guard')
namespace = {'Page': object, 'urlparse': urlparse, 'API_ORIGIN': 'https://api.example.test', 'SAFE_METHODS': {'GET', 'HEAD', 'OPTIONS'}}
exec(compile(ast.Module(body=[node], type_ignores=[]), '<actual read-only guard>', 'exec'), namespace)


class Page:
    def __init__(self):
        self.closed = False
        self.main_frame = object()
        self.listeners = {}

    def on(self, event, handler):
        self.listeners[event] = handler

    def route(self, pattern, handler):
        self.handler = handler

    def is_closed(self):
        return self.closed


class Route:
    def __init__(self, page, method='GET', failure=None, error=None, navigate=False):
        self.page = page
        self.request = SimpleNamespace(method=method, url='http://127.0.0.1/api/stats', failure=failure)
        self.error = error
        self.navigate = navigate
        self.fetched = False
        self.fulfilled = False
        self.aborted = False

    def fetch(self, **kwargs):
        self.fetched = True
        if self.navigate:
            self.page.listeners['framenavigated'](self.page.main_frame)
        return SimpleNamespace(status=200, body=lambda: b'{}', headers={})

    def fulfill(self, **kwargs):
        if self.error:
            raise RuntimeError(self.error)
        self.fulfilled = True

    def abort(self, reason):
        self.aborted = True


class GuardTests(unittest.TestCase):
    def run_route(self, **kwargs):
        page = Page()
        log = {'blocked_mutations': []}
        namespace['attach_read_only_guard'](page, log)
        route = Route(page, **kwargs)
        page.handler(route)
        return route, log

    def test_read_proxy(self):
        route, _ = self.run_route()
        self.assertTrue(route.fulfilled)

    def test_mutations_never_reach_upstream(self):
        for method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            with self.subTest(method=method):
                route, log = self.run_route(method=method)
                self.assertTrue(route.aborted)
                self.assertFalse(route.fetched)
                self.assertEqual(len(log['blocked_mutations']), 1)

    def test_navigated_document_cancellation(self):
        self.run_route(error='Route.fulfill: Route is already handled!', navigate=True)

    def test_aborted_request(self):
        self.run_route(error='Route.fulfill: Route is already handled!', failure='net::ERR_ABORTED')

    def test_unexplained_duplicate_is_still_fatal(self):
        with self.assertRaisesRegex(RuntimeError, 'already handled'):
            self.run_route(error='Route.fulfill: Route is already handled!')

    def test_real_network_errors_are_not_hidden_by_navigation(self):
        with self.assertRaisesRegex(RuntimeError, 'upstream timeout'):
            self.run_route(error='upstream timeout', navigate=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
