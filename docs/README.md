# ReshEge Helper

[English](./README.md) | [Русский](../README_ru.md)

ReshEge Helper is a userscript that enhances the ReshEge game interface by adding a modern menu, match history, leaderboard, and customization options.

## ✨ Features

*   Convenient side menu
*   Leaderboard viewer
*   Match history with detailed error breakdown
*   Light and dark theme support
*   Smooth and fast interface
*   Connection status indicator
*   Extensible functionality

## 🛠️ Installation

You need a userscript manager such as **Tampermonkey** or **Violentmonkey** to use this script.

### Step-by-step guide:

1.  **Install a userscript manager:**
    *   **Tampermonkey:** [Chrome Web Store](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/tampermonkey/)
    *   **Violentmonkey:** [Chrome Web Store](https://chrome.google.com/webstore/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag) | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/violentmonkey/)

2.  **Open the manager's dashboard.** Usually accessible via the extension icon in the browser toolbar.

3.  **Create a new script:**
    *   In Tampermonkey click `➕` (Create a new script).
    *   In Violentmonkey click `+` (Create a new script).

4.  **Replace the new script's content with the ReshEge Helper code:**
    *   Open the [script file (script.js)](https://github.com/Danex-Exe/ege-game/blob/main/script.js) in the repository.
    *   Click the `Raw` button to view the source code.
    *   Copy all the code (Ctrl+A → Ctrl+C).
    *   Go back to the manager's editor, select all content (Ctrl+A), and paste the copied code (Ctrl+V).

5.  **Save the script:**
    *   In Tampermonkey press `Ctrl+S` or `File` → `Save`.
    *   In Violentmonkey click `Save & Close`.

6.  **Verify the installation:**
    *   Go to the game page [«Hold the Line»](https://ege.sdamgia.ru/game.htm).
    *   A **«MENU»** button should appear on the left side of the screen.
    *   Done! You have successfully installed ReshEge Helper.

## 📖 Usage

Once installed, a **«MENU»** button appears in the interface. Click it to open the side panel.

Through the panel you can:

*   **Leaderboard:** View top players.
*   **History:** Detailed breakdown of past matches.
*   **Settings:** Switch between light and dark theme.

## 📜 Match History

Match history displays information about past games: opponents, rating changes, and time. A detailed error breakdown for each task is also available.

## 🎨 Themes

Both light and dark themes are available. The chosen theme is saved automatically.

## ⚙️ Architecture

The project is built around a modular menu management system responsible for rendering the interface and navigation. Data is loaded dynamically and displayed in the UI.

## 🧩 Extending

The script can be extended by adding new elements and functions without modifying the core logic.

## 🐛 Debugging

Information about the script's operation is available in the browser console (F12 → Console).

## 📄 License

[MIT](../LICENSE)