"""Every deployed Modal function hands invoke_native a callable operation."""
from __future__ import annotations

import inspect
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import modal_app

NATIVE_FUNCTIONS = ("asset_validation", "outbound_delivery", "fetch_source", "pin_source", "prepare_clip",
                    "render_group", "publication", "export_bundle", "dub_mix", "generated_image")


class ModalOperationWiringTests(unittest.IsolatedAsyncioTestCase):
    async def test_operations_accept_the_arguments_invoke_native_passes(self):
        for name in NATIVE_FUNCTIONS:
            with self.subTest(function=name):
                invoke = AsyncMock(return_value={"disposition": "completed"})
                with patch("narriflow_media.entrypoint.invoke_native", invoke), \
                        patch("narriflow_media.entrypoint.native_client", Mock()):
                    await getattr(modal_app, name).local({})
                # A required keyword here is a TypeError inside invoke_native,
                # which reports it as a retryable media_execution_failed.
                inspect.signature(invoke.call_args.kwargs["operation"]).bind(object(), object(), Path("work"))


if __name__ == "__main__":
    unittest.main()
