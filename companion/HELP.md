## Companion Module for Studio Technologies Dante Devices

### v0.7.6

Controls Studio Technologies Dante intercom and audio devices over your Dante network.

---

#### Supported Devices

| Model              | Description                   |
| ------------------ | ----------------------------- |
| 207 / 207A         | eSports Console               |
| 209                | Talent Console                |
| 214 / 214A / 216A  | Announcer Console             |
| 232 / 234 / 236    | Announcer Console             |
| 348                | Broadcast Console (8-channel) |
| 370A / 373A / 374A | Desktop Intercom Station      |
| 391                | Alerting Unit                 |
| 392                | Visual Indicator Unit         |
| 545DC              | Party-Line Interface          |
| 5205               | Mic/Line to Dante             |
| 5304               | Dante Intercom Station        |
| 5364               | Headset Interface             |
| 5365               | Headset Interface             |
| 5401A              | Dante Leader Clock            |
| 5414               | Mic Preamp                    |

---

#### Configuration

The module discovers Studio Technologies devices automatically on your Dante network. Two connection modes are available:

**Auto Mode (Recommended)**

1. Leave **Host IP** blank.
2. Open the module's configuration page — discovered devices will appear in the **Device** dropdown.
3. Select the device you want to control. The module will track that device by its MAC address even if its IP changes.

**Manual Mode**

1. Enter the device's **Host IP** address directly.
2. Select the **Model** from the dropdown.
3. The module will verify the device at that IP matches the selected model before sending any commands.

> If a model mismatch is detected, all commands are blocked and the connection status shows the mismatch. Correct the IP or model selection to restore control.

---

#### Actions

Actions are generated automatically from the device's schema. Each setting on the device has a corresponding action. Examples:

- **Mic Gain** — set the microphone preamplifier gain
- **Button Mode** — set the operation mode of a channel button
- **Headset Routing** — route a channel to the headset output
- **GLOBAL: Get All Settings** — [Dev Mode ONLY] request a full settings refresh from the device (also creates a device JSON schema file if one doesn't exist yet)

Select the device action by model prefix (e.g. `[Model348] Button Mode`), choose the channel and value, and apply.

---

#### Feedbacks

Each setting also has one or two feedback types:

- **Value feedback** — returns the current numeric value; optionally displays the choice label. Use with a variable text overlay.
- **Boolean feedback** — available for On/Off settings; returns true when the setting is in the "On" state. Use for button colouring.

---

#### Variables

Each device setting is exposed as a Companion variable, updated automatically whenever the device reports a state change. Variable names follow the pattern `[model]_[cmd]_[id]`.

---

#### Troubleshooting

- **Status shows "Discovering…" and stays there** — ensure the Companion host is on the same Dante network segment as the device, and that multicast UDP traffic is not blocked.
- **Status shows "Model mismatch"** — the device at the configured IP is a different model than selected. Correct the model in configuration.
- **Actions are greyed out / not listed** — the device JSON schema has not been created yet. Add a **GLOBAL: Get All Settings** action and trigger it once to generate the schema.
- **Commands are blocked** — the device IP is not authorized. Check that the IP and model match, or switch to Auto mode and select the device from the dropdown.

---

Bugs and feature requests: [https://discourse.checkcheckonetwo.com/c/stream-deck-companion/studio-technologies-dante-module/36](https://discourse.checkcheckonetwo.com/c/stream-deck-companion/studio-technologies-dante-module/36)
