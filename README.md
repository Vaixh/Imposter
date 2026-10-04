## Requirements

- [Node.js](https://nodejs.org) (LTS version)
- All players' phones must be on the same Wi-Fi as the PC running the server

## Installation

Clone the repository and install the dependencies:

```
git clone https://github.com/Vaixh/Imposter.git
cd Imposter
npm install
```

This installs:
- **express** – serves the game page to the phones
- **socket.io** – real-time connection between server and phones
- **qrcode-terminal** – shows a QR code on startup so players can join by scanning it

## Start

On Windows, double-click `start.bat`. Alternatively run:

```
node server.js
```

Scan the QR code shown in the console with your phone, or open the address shown below it in your phone's browser.
