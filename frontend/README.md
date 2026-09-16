<p align="center">
  <img src="public/logo.svg" alt="CAN Do Message Catalog Logo" width="215" height="215" />
</p>

<h1 align="center">CAN Do Message Catalog</h1>

<p align="center">
  <b>A community-driven catalog and exploration tool for CAN bus messages, commands, and automations.</b>
</p>

<p align="center">
  <a href="https://supersuave.github.io/CAN-Do-Message-Catalog/"><strong>Explore and Contribute to the Live Catalog!</strong></a>
</p>

---

## 🚗 Overview

The **CAN Do Message Catalog** is an open-source reference library for documenting, decoding, and sharing CAN (Controller Area Network) bus messages and automation commands across vehicle makes, models, and regions. 

Because automotive reverse engineering is a collaborative effort, this repository relies on crowd-sourced contributions. Every decoded message, feature tag, PID, and command is cataloged and verified by the community.

---

## ✨ Key Features

- **🔍 Advanced Filtering & Search**: Instantly filter messages by category, subcategory, vehicle make, model, region, and custom features.
- **🚗 Multi-Vehicle Support**: Browse messages organized by specific vehicles and automation targets.
- **📋 Copy & Export**: Quickly copy raw CAN hex messages, IDs, and payload data for your projects.
- **🤝 Community Contributions**: Easily submit new discovered messages and commands directly through the app interface (integrated with GitHub contributions).
- **📱 Responsive & Modern UI**: Built with React, TypeScript, and Tailwind CSS for a seamless experience on desktop and mobile devices.

---

## 🛠️ Getting Started Locally

If you want to run or develop the catalog locally:

1. **Clone the repository**:
   ```bash
   git clone https://github.com/supersuave/CAN-Do-Message-Catalog.git
   cd CAN-Do-Message-Catalog
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the development server**:
   ```bash
   npm run dev
   ```

4. **Build for production**:
   ```bash
   npm run build
   ```

---

## 🤝 How to Contribute

We welcome contributions from everyone! Whether you've reverse-engineered a new command for your car, discovered a convenience feature message, or improved documentation:

1. **Submit via the App**: Use the built-in contribution modal in the web app to generate and submit message entries.
2. **Submit via Pull Request**: Edit `can_do_catalog.json` directly or submit a pull request with your new discoveries.
3. **Open an Issue**: Report missing vehicles, incorrect IDs, or suggest new categorization tags.

---

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
