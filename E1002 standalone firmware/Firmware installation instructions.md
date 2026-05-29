## Install Arduino IDE
- Download and install it from arduino.cc/en/software if you don't already have it.
## Add ESP32 board support
- Go to File > Preferences, and in the "Additional Boards Manager URLs" field, paste:

    `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
- Then go to Tools > Board > Boards Manager, search for esp32, and install the esp32 by Espressif Systems package.

## Install the libraries
- PNGdec and Adafruit GFX Library: Install both from Tools > Manage Libraries by searching their names.
- GxEPD2: [Download repo as Zip](https://github.com/ZinggJM/GxEPD2) (Code > Download ZIP), then install via `Sketch > Include Library > Add .ZIP Library`. The GitHub version is recommended over the Library Manager version since it has the latest display driver support for the E1002.

## Connect the device
Plug in the USB-C cable and flip the power switch on the back to ON. Make sure the device is awake (press the green button if the LED is off).
## Configure Arduino IDE settings

- Tools > Board > ESP32 Arduino > XIAO_ESP32S3
- Tools > PSRAM > OPI PSRAM
- Tools > Port - select the COM port that appeared when you plugged in the device

## Open and upload
Open the .ino file in Arduino IDE, then click the Upload button (right arrow icon). It will compile and flash. This takes a minute or two.
