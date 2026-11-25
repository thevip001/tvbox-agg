#!/usr/bin/env python3
import importlib.util
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("egress_proxy", "runtime/egress-proxy/proxy.py")
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)

class PublicDestinationPolicyTests(unittest.TestCase):
    def test_rejects_loopback_private_link_local_and_metadata_ranges(self):
        for address in ("127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
                        "169.254.169.254", "100.64.0.1", "192.0.0.9", "198.18.0.1", "::1", "fc00::1", "fe80::1", "64:ff9b::a00:1"):
            with self.subTest(address=address):
                with patch.object(proxy, "ALLOWED_HOSTS", {address}):
                    with self.assertRaises(ValueError):
                        proxy.resolve_public(address, 443)

    def test_accepts_public_ip_literal(self):
        with patch.object(proxy, "ALLOWED_HOSTS", {"1.1.1.1"}):
            self.assertEqual(proxy.resolve_public("1.1.1.1", 443), ["1.1.1.1"])

    def test_rejects_mixed_public_and_private_dns_answers(self):
        answers = [
            (2, 1, 6, "", ("1.1.1.1", 0)),
            (2, 1, 6, "", ("192.168.1.10", 0)),
        ]
        with patch.object(proxy, "ALLOWED_HOSTS", {"rebind.example"}), \
             patch.object(proxy.socket, "getaddrinfo", return_value=answers):
            with self.assertRaises(ValueError):
                proxy.resolve_public("rebind.example", 443)

    def test_wildcard_allowlist_matches_subdomains_only(self):
        with patch.object(proxy, "ALLOWED_HOSTS", {"*.example.com"}), \
             patch.object(proxy.socket, "getaddrinfo", return_value=[
                 (2, 1, 6, "", ("1.1.1.1", 443))
             ]):
            self.assertEqual(proxy.resolve_public("api.example.com", 443), ["1.1.1.1"])
            with self.assertRaises(ValueError):
                proxy.resolve_public("example.com", 443)

    def test_unlisted_domain_is_rejected_before_dns(self):
        with patch.object(proxy, "ALLOWED_HOSTS", set()), \
             patch.object(proxy.socket, "getaddrinfo") as resolver:
            with self.assertRaises(ValueError):
                proxy.resolve_public("not-allowed.example", 443)
            resolver.assert_not_called()

    def test_connect_uses_resolved_address_not_second_dns_lookup(self):
        # connect_pinned resolves once and connects to that exact numeric address.
        # This is the key DNS-rebinding protection (resolution/connect pinning).
        answers = [(2, 1, 6, "", ("1.1.1.1", 443))]
        with patch.object(proxy, "ALLOWED_HOSTS", {"public.example"}), \
             patch.object(proxy.socket, "getaddrinfo", return_value=answers), \
             patch.object(proxy.socket.socket, "connect") as connect:
            sock = proxy.connect_pinned("public.example", 443)
            connect.assert_called_once_with(("1.1.1.1", 443))
            sock.close()

if __name__ == "__main__":
    unittest.main()
