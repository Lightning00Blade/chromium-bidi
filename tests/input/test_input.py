# Copyright 2023 Google LLC.
# Copyright (c) Microsoft Corporation.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import pytest
from syrupy.filters import props
from test_helpers import execute_command, goto_url

SET_FILES_HTML = """
<input id=input type=file>
<script>
    var allEvents = [];
    const input = document.getElementById('input');
    input.addEventListener('change', (event) => {
        allEvents.push({
            type: event.type,
            files: [...event.target.files].map((file) => file.name)
        })
    });
    input.addEventListener('cancel', (event) => {
        allEvents.push({
            type: event.type,
            files: [...event.target.files].map((file) => file.name)
        })
    });
</script>
"""

SCRIPT = """
<!DOCTYPE html>
<html>
<body style="touch-action: none">
<div style="height: 2000px; width: 10px"></div>
<script>
    var allEvents = [];
    for (const name of [
        "mousedown",
        "mousemove",
        "mouseup",
        "touchmove",
        "touchstart",
        "touchend",
        "keydown",
        "keypress",
        "keyup",
        "wheel"
    ]) {
        window.addEventListener(name, (event) => {
            switch (name) {
                case "pointerdown":
                case "pointermove":
                case "pointerup":
                    allEvents.push({
                        type: name,
                        x: event.x,
                        y: event.y,
                        width: event.width,
                        height: event.height,
                        altitudeAngle: event.altitudeAngle,
                        azimuthAngle: event.azimuthAngle,
                        pressure: event.pressure,
                        pointerType: event.pointerType,
                        twist: event.twist,
                        tiltX: event.tiltX,
                        tiltY: event.tiltY,
                    });
                    break;
                case "mousedown":
                case "mousemove":
                case "mouseup":
                    allEvents.push({
                        event: name,
                        button: event.button,
                        buttons: event.buttons,
                        clientX: event.clientX,
                        clientY: event.clientY,
                        clickCount: event.detail,
                    });
                    break;
                case "keydown":
                case "keypress":
                case "keyup":
                    allEvents.push({
                        event: name,
                        key: event.key,
                        code: event.code,
                        charCode: event.charCode,
                        keyCode: event.keyCode,
                    });
                    break;
                case "touchstart":
                case "touchmove":
                case "touchend":
                    allEvents.push({
                        event: name,
                        changedTouches: [...event.changedTouches].map((touch) => ({
                            clientX: touch.clientX,
                            clientY: touch.clientY,
                            radiusX: touch.radiusX,
                            radiusY: touch.radiusY,
                            force: touch.force,
                        })),
                        activeTouches: [...event.touches].map((touch) => ({
                            clientX: touch.clientX,
                            clientY: touch.clientY,
                            radiusX: touch.radiusX,
                            radiusY: touch.radiusY,
                            force: touch.force,
                        })),
                    });
                    break;
                case "wheel":
                    allEvents.push({
                        event: name,
                        deltaX: event.deltaX,
                        deltaY: event.deltaY,
                        deltaZ: event.deltaZ,
                    });
                    break;
            }
        });
    }
</script>
</body>
</html>
"""

DRAG_SCRIPT = """
<div
  style="height: 100px; width: 100px; background-color: red"
  id="drag-target"
  draggable="true"
></div>
<div
  style="height: 100px; width: 100px; background-color: blue"
  id="drop-target"
  ondragenter="event.preventDefault()"
  ondragover="event.preventDefault()"
></div>
<script>
  var allEvents = [];
  for (const name of [
      "mousedown",
      "mousemove",
      "dragstart",
      "dragend",
      "dragover",
      "dragleave",
      "dragenter",
      "drop"
  ]) {
      window.addEventListener(name, (event) => {
          if (event instanceof MouseEvent) {
            allEvents.push({
                event: name,
                button: event.button,
                buttons: event.buttons,
                clientX: event.clientX,
                clientY: event.clientY,
            });
          }
      }, true);
  }
</script>
"""


async def reset_mouse(websocket, context_id):
    """Ensures the mouse is at the origin and events are cleared. This is helpful
    for headful which has problems due to the hardware mouse being within the
    test window"""
    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "pointer",
                    "id": "main_mouse",
                    "actions": [{
                        "type": "pointerMove",
                        "x": 0,
                        "y": 0,
                    }]
                }]
            }
        })
    await execute_command(
        websocket, {
            "method": "script.evaluate",
            "params": {
                "expression": "allEvents = []",
                "awaitPromise": False,
                "target": {
                    "context": context_id
                }
            }
        })


def get_events(websocket, context_id):
    return execute_command(
        websocket, {
            "method": "script.evaluate",
            "params": {
                "expression": "allEvents",
                "awaitPromise": False,
                "target": {
                    "context": context_id
                }
            }
        })


@pytest.mark.asyncio
async def test_input_performActionsEmitsKeyboardEvents(websocket, context_id,
                                                       html, activate_main_tab,
                                                       snapshot):
    await goto_url(websocket, context_id, html(SCRIPT))
    await activate_main_tab()
    await reset_mouse(websocket, context_id)

    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "key",
                    "id": "main_keyboard",
                    "actions": [{
                        "type": "keyDown",
                        "value": "a",
                    }, {
                        "type": "keyUp",
                        "value": "a",
                    }]
                }]
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))


@pytest.mark.asyncio
async def test_input_performActionsEmitsDragging(websocket, context_id, html,
                                                 query_selector, snapshot,
                                                 activate_main_tab):
    await goto_url(websocket, context_id, html(DRAG_SCRIPT))
    await activate_main_tab()
    await reset_mouse(websocket, context_id)

    drag_target = await query_selector('#drag-target')
    drop_target = await query_selector('#drop-target')

    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "pointer",
                    "id": "main_mouse",
                    "actions": [{
                        "type": "pointerMove",
                        "x": 0,
                        "y": 0,
                        "origin": {
                            "type": "element",
                            "element": drag_target
                        }
                    }, {
                        "type": "pointerDown",
                        "button": 0,
                    }, {
                        "type": "pointerMove",
                        "x": 0,
                        "y": 0,
                        "origin": {
                            "type": "element",
                            "element": drop_target
                        }
                    }, {
                        "type": "pointerUp",
                        "button": 0,
                    }, {
                        "type": "pointerMove",
                        "x": 1,
                        "y": 1,
                        "origin": {
                            "type": "element",
                            "element": drop_target
                        }
                    }]
                }]
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))


@pytest.mark.asyncio
async def test_input_performActionsCancelsDragging(websocket, context_id, html,
                                                   query_selector, snapshot,
                                                   activate_main_tab):
    await goto_url(websocket, context_id, html(DRAG_SCRIPT))
    await activate_main_tab()
    await reset_mouse(websocket, context_id)

    drag_target = await query_selector('#drag-target')
    drop_target = await query_selector('#drop-target')

    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "pointer",
                    "id": "main_mouse",
                    "actions": [{
                        "type": "pointerMove",
                        "x": 0,
                        "y": 0,
                        "origin": {
                            "type": "element",
                            "element": drag_target
                        }
                    }, {
                        "type": "pointerDown",
                        "button": 0,
                    }, {
                        "type": "pointerMove",
                        "x": 0,
                        "y": 0,
                        "origin": {
                            "type": "element",
                            "element": drop_target
                        }
                    }]
                }]
            }
        })

    await execute_command(
        websocket,
        {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "key",
                    "id": "main_keyboard",
                    "actions": [{
                        "type": "keyDown",
                        # Pressing Escape
                        "value": "\uE00C",
                    }]
                }]
            }
        })

    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "pointer",
                    "id": "main_mouse",
                    "actions": [{
                        "type": "pointerMove",
                        "x": 1,
                        "y": 1,
                        "origin": {
                            "type": "element",
                            "element": drop_target
                        }
                    }]
                }]
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))


@pytest.mark.asyncio
async def test_input_performActionsDoesNotCancelDraggingWithAlt(
        websocket, context_id, html, query_selector, snapshot,
        activate_main_tab):
    await goto_url(websocket, context_id, html(DRAG_SCRIPT))
    await activate_main_tab()
    await reset_mouse(websocket, context_id)

    drag_target = await query_selector('#drag-target')
    drop_target = await query_selector('#drop-target')

    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "pointer",
                    "id": "main_mouse",
                    "actions": [{
                        "type": "pointerMove",
                        "x": 0,
                        "y": 0,
                        "origin": {
                            "type": "element",
                            "element": drag_target
                        }
                    }, {
                        "type": "pointerDown",
                        "button": 0,
                    }, {
                        "type": "pointerMove",
                        "x": 0,
                        "y": 0,
                        "origin": {
                            "type": "element",
                            "element": drop_target
                        }
                    }]
                }]
            }
        })

    await execute_command(
        websocket,
        {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "key",
                    "id": "main_keyboard",
                    "actions": [
                        {
                            "type": "keyDown",
                            # Pressing Alt
                            "value": "\uE00A",
                        },
                        {
                            "type": "keyDown",
                            # Pressing Escape
                            "value": "\uE00C",
                        }
                    ]
                }]
            }
        })

    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "pointer",
                    "id": "main_mouse",
                    "actions": [{
                        "type": "pointerMove",
                        "x": 1,
                        "y": 1,
                        "origin": {
                            "type": "element",
                            "element": drop_target
                        }
                    }]
                }]
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))


@pytest.mark.asyncio
async def test_input_performActionsEmitsPointerEvents(websocket, context_id,
                                                      html, activate_main_tab,
                                                      snapshot):
    await goto_url(websocket, context_id, html(SCRIPT))
    await activate_main_tab()
    await reset_mouse(websocket, context_id)

    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "pointer",
                    "id": "main_mouse",
                    "actions": [{
                        "type": "pointerDown",
                        "button": 0,
                    }, {
                        "type": "pointerMove",
                        "x": 1,
                        "y": 1,
                    }, {
                        "type": "pointerUp",
                        "button": 0,
                    }]
                }]
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))


@pytest.mark.asyncio
async def test_input_performActionsEmitsWheelEvents(websocket, context_id,
                                                    html, activate_main_tab,
                                                    snapshot):
    await goto_url(websocket, context_id, html(SCRIPT))
    await activate_main_tab()
    await reset_mouse(websocket, context_id)

    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "pointer",
                    "id": "main_mouse",
                    "actions": [{
                        "type": "pointerDown",
                        "button": 0,
                    }, {
                        "type": "pointerUp",
                        "button": 0,
                    }]
                }, {
                    "type": "wheel",
                    "id": "main_wheel",
                    "actions": [{
                        "type": "scroll",
                        "x": 0,
                        "y": 0,
                        "deltaX": 0,
                        "deltaY": 5,
                    }]
                }]
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))


@pytest.mark.asyncio
async def test_input_performActionsEmitsClickCountsByButton(
        websocket, context_id, html, activate_main_tab, snapshot):
    await goto_url(websocket, context_id, html(SCRIPT))
    await activate_main_tab()
    await reset_mouse(websocket, context_id)

    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "pointer",
                    "id": "main_mouse",
                    "actions": [{
                        "type": "pointerDown",
                        "button": 0,
                    }, {
                        "type": "pointerUp",
                        "button": 0,
                    }, {
                        "type": "pointerDown",
                        "button": 0,
                    }, {
                        "type": "pointerUp",
                        "button": 0,
                    }, {
                        "type": "pointerDown",
                        "button": 1,
                    }, {
                        "type": "pointerUp",
                        "button": 1,
                    }]
                }]
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))


@pytest.mark.asyncio
async def test_input_setFiles(websocket, context_id, html, snapshot,
                              query_selector):
    await goto_url(websocket, context_id, html(SET_FILES_HTML))

    input = await query_selector('#input')

    await execute_command(
        websocket, {
            "method": "input.setFiles",
            "params": {
                "context": context_id,
                "element": input,
                "files": ["path/to/noop.txt"],
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))


@pytest.mark.asyncio
async def test_input_setFiles_twice(websocket, context_id, html, snapshot,
                                    query_selector):
    await goto_url(websocket, context_id, html(SET_FILES_HTML))

    input = await query_selector('#input')

    await execute_command(
        websocket, {
            "method": "input.setFiles",
            "params": {
                "context": context_id,
                "element": input,
                "files": ["path/to/noop.txt"],
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))

    await execute_command(
        websocket, {
            "method": "input.setFiles",
            "params": {
                "context": context_id,
                "element": input,
                "files": ["path/to/noop-2.txt"],
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))


@pytest.mark.asyncio
async def test_input_setFiles_twice_same(websocket, context_id, html, snapshot,
                                         query_selector):
    await goto_url(websocket, context_id, html(SET_FILES_HTML))

    input = await query_selector('#input')

    await execute_command(
        websocket, {
            "method": "input.setFiles",
            "params": {
                "context": context_id,
                "element": input,
                "files": ["path/to/noop.txt"],
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))

    await execute_command(
        websocket, {
            "method": "input.setFiles",
            "params": {
                "context": context_id,
                "element": input,
                "files": ["path/to/noop.txt"],
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))


@pytest.mark.asyncio
async def test_input_setFiles_noSuchElement(websocket, context_id, html,
                                            snapshot):
    await goto_url(websocket, context_id, html(SET_FILES_HTML))

    message = None
    try:
        await execute_command(
            websocket, {
                "method": "input.setFiles",
                "params": {
                    "context": context_id,
                    "element": {
                        "sharedId": "invalid"
                    },
                    "files": ["path/to/noop.txt"],
                }
            })
    except Exception as exception:
        message = exception.args[0]['error']

    assert message == snapshot


@pytest.mark.asyncio
async def test_input_setFiles_unableToSetFileInput(websocket, context_id, html,
                                                   snapshot, query_selector):
    await goto_url(websocket, context_id,
                   html(SET_FILES_HTML.replace('<input', '<input disabled')))

    input = await query_selector('#input')

    message = None
    try:
        await execute_command(
            websocket, {
                "method": "input.setFiles",
                "params": {
                    "context": context_id,
                    "element": input,
                    "files": ["path/to/noop.txt"],
                }
            })
    except Exception as exception:
        message = exception.args[0]['error']

    assert message == snapshot


@pytest.mark.asyncio
async def test_input_performActionsEmitsTouchEvents(websocket, context_id,
                                                    html, activate_main_tab,
                                                    snapshot):
    await goto_url(websocket, context_id, html(SCRIPT))
    await activate_main_tab()
    await reset_mouse(websocket, context_id)

    await execute_command(
        websocket, {
            "method": "input.performActions",
            "params": {
                "context": context_id,
                "actions": [{
                    "type": "pointer",
                    "id": "main_touch",
                    "parameters": {
                        "pointerType": "touch"
                    },
                    "actions": [{
                        "type": "pointerMove",
                        "x": 0,
                        "y": 0
                    }, {
                        "type": "pointerDown",
                        "button": 0
                    }, {
                        "type": "pointerMove",
                        "x": 30,
                        "y": 30
                    }, {
                        "type": "pointerMove",
                        "x": 48,
                        "y": 35
                    }, {
                        "type": "pointerMove",
                        "x": 80,
                        "y": 50
                    }, {
                        "type": "pointerMove",
                        "x": 100,
                        "y": 100
                    }, {
                        "type": "pointerUp",
                        "button": 0
                    }]
                }]
            }
        })

    result = await get_events(websocket, context_id)

    assert result == snapshot(exclude=props("realm"))
