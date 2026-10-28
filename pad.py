import sys

# server.js sends lines like "PRESS A" / "RELEASE UP" on stdin.
# Player 3's buttons arrive with a "P3_" in front (for example "PRESS P3_UP") and go to a second pad.
# Each OS gets its own way to turn those into game input.


def make_linux_pad():
    # One virtual Xbox 360 pad through uinput (needs sudo or uinput permission)
    from evdev import UInput, AbsInfo, ecodes as e

    STICK = AbsInfo(0, -32768, 32767, 16, 128, 0)
    TRIGGER = AbsInfo(0, 0, 255, 0, 0, 0)
    HAT = AbsInfo(0, -1, 1, 0, 0, 0)

    caps = {
        e.EV_KEY: [e.BTN_SOUTH, e.BTN_EAST, e.BTN_NORTH, e.BTN_WEST,
                   e.BTN_TL, e.BTN_TR, e.BTN_SELECT, e.BTN_START],
        e.EV_ABS: [
            (e.ABS_X, STICK), (e.ABS_Y, STICK), (e.ABS_Z, TRIGGER),
            (e.ABS_RX, STICK), (e.ABS_RY, STICK), (e.ABS_RZ, TRIGGER),
            (e.ABS_HAT0X, HAT), (e.ABS_HAT0Y, HAT),
        ],
    }
    ui = UInput(caps, name="Microsoft X-Box 360 pad", vendor=0x045e, product=0x028e, version=0x110)

    # Tekken default on Xbox layout: X = 1 (LP), Y = 2 (RP), A = 3 (LK), B = 4 (RK)
    buttons = {
        '1': e.BTN_NORTH, '2': e.BTN_WEST, '3': e.BTN_SOUTH, '4': e.BTN_EAST,
        'L1': e.BTN_TL, 'R1': e.BTN_TR, 'SELECT': e.BTN_SELECT, 'START': e.BTN_START,
    }
    triggers = {'L2': e.ABS_Z, 'R2': e.ABS_RZ}
    hats = {'UP': (e.ABS_HAT0Y, -1), 'DOWN': (e.ABS_HAT0Y, 1),
            'LEFT': (e.ABS_HAT0X, -1), 'RIGHT': (e.ABS_HAT0X, 1)}

    def send(button, down):
        if button in buttons:
            ui.write(e.EV_KEY, buttons[button], 1 if down else 0)
        elif button in triggers:
            ui.write(e.EV_ABS, triggers[button], 255 if down else 0)
        elif button in hats:
            axis, val = hats[button]
            ui.write(e.EV_ABS, axis, val if down else 0)
        else:
            return
        ui.syn()

    return send


def make_windows_pad():
    # One virtual Xbox 360 pad through the ViGEmBus driver.
    # Needs:  pip install vgamepad   (it also offers to install the ViGEmBus driver)
    import vgamepad as vg

    pad = vg.VX360Gamepad()
    B = vg.XUSB_BUTTON

    buttons = {
        '1': B.XUSB_GAMEPAD_X, '2': B.XUSB_GAMEPAD_Y,
        '3': B.XUSB_GAMEPAD_A, '4': B.XUSB_GAMEPAD_B,
        'L1': B.XUSB_GAMEPAD_LEFT_SHOULDER, 'R1': B.XUSB_GAMEPAD_RIGHT_SHOULDER,
        'SELECT': B.XUSB_GAMEPAD_BACK, 'START': B.XUSB_GAMEPAD_START,
        'UP': B.XUSB_GAMEPAD_DPAD_UP, 'DOWN': B.XUSB_GAMEPAD_DPAD_DOWN,
        'LEFT': B.XUSB_GAMEPAD_DPAD_LEFT, 'RIGHT': B.XUSB_GAMEPAD_DPAD_RIGHT,
    }

    def send(button, down):
        if button in buttons:
            if down:
                pad.press_button(button=buttons[button])
            else:
                pad.release_button(button=buttons[button])
        elif button == 'L2':
            pad.left_trigger(value=255 if down else 0)
        elif button == 'R2':
            pad.right_trigger(value=255 if down else 0)
        else:
            return
        pad.update()

    return send


def setup_mac():
    # macOS has no common virtual-gamepad driver, so this presses keyboard keys instead.
    # Needs:  pip3 install pynput   and  System Settings > Privacy & Security > Accessibility
    # Change the keys below to match the game's keyboard controls.
    # Only Player 2 works on macOS (one keyboard); Player 3's buttons are ignored.
    from pynput.keyboard import Controller, Key

    kb = Controller()
    keys = {
        'UP': Key.up, 'DOWN': Key.down, 'LEFT': Key.left, 'RIGHT': Key.right,
        '1': 'u', '2': 'i', '3': 'j', '4': 'k',
        'L1': 'q', 'R1': 'e', 'L2': 'z', 'R2': 'c',
        'SELECT': Key.shift, 'START': Key.enter,
    }

    def send(button, down):
        key = keys.get(button)
        if key is None:
            return
        if down:
            kb.press(key)
        else:
            kb.release(key)

    return send, (lambda button, down: None)


def main():
    try:
        if sys.platform.startswith('linux'):
            # two pads, so a game sees "player 1" and "player 2" controllers
            send_p2, send_p3 = make_linux_pad(), make_linux_pad()
        elif sys.platform == 'win32':
            send_p2, send_p3 = make_windows_pad(), make_windows_pad()
        elif sys.platform == 'darwin':
            send_p2, send_p3 = setup_mac()
        else:
            sys.exit(f"Unsupported system: {sys.platform}")
    except ImportError as err:
        hints = {'linux': 'pip install evdev', 'win32': 'pip install vgamepad', 'darwin': 'pip3 install pynput'}
        key = 'linux' if sys.platform.startswith('linux') else sys.platform
        sys.exit(f"Missing Python package ({err.name}). Install it with:  {hints.get(key, '')}")

    for line in sys.stdin:
        parts = line.split()
        if len(parts) != 2:
            continue
        action, button = parts
        send = send_p2
        if button.startswith('P3_'):
            send = send_p3
            button = button[3:]
        send(button, action == 'PRESS')


if __name__ == '__main__':
    main()