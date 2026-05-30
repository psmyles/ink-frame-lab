/**
 * reTerminal E1002 Digital Photo Frame
 * =====================================
 * A gift-friendly digital photo frame with two modes:
 *
 * NORMAL MODE (default):
 *   Wakes from deep sleep, shows a random image from SD card,
 *   draws a battery bar, and goes back to sleep.
 *
 * SETUP MODE (hold green button during boot for 3 seconds):
 *   Creates a Wi-Fi hotspot and web server for managing photos.
 *   The ePaper screen shows step-by-step instructions with the
 *   Wi-Fi name, password, and web address.
 *
 * Hardware: Seeed Studio reTerminal E1002
 *   - ESP32-S3 (8MB PSRAM, 32MB Flash)
 *   - 7.3" E Ink Spectra 6 color ePaper (800x480, 6 colors)
 *   - MicroSD card slot (shared SPI bus with display)
 *   - 2000mAh Li-Po battery with ADC monitoring
 *
 * SD Card Layout:
 *   /images/        - Folder with PNG images named 1.png, 2.png, etc.
 *   /config.txt     - Auto-managed configuration file
 *
 * Libraries Required:
 *   - GxEPD2 by Jean-Marc Zingg (from GitHub)
 *   - PNGdec by Larry Bank
 *   - Adafruit GFX Library
 *   - SD, SPI, WiFi, WebServer (built-in with ESP32 Arduino core)
 *
 * Board: XIAO_ESP32S3 with OPI PSRAM enabled
 */

#include <SD.h>
#include <SPI.h>
#include <GxEPD2_7C.h>
#include <PNGdec.h>
#include <WiFi.h>
#include <WebServer.h>
#include <esp_sleep.h>
#include <esp_random.h>
#include <Fonts/FreeSans9pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold18pt7b.h>
#include <Fonts/FreeSansBold24pt7b.h>

// =============================================================================
// Pin Definitions (from reTerminal E1002 schematic)
// =============================================================================

// ePaper Display SPI pins
#define EPD_SCK_PIN   7
#define EPD_MOSI_PIN  9
#define EPD_CS_PIN    10
#define EPD_DC_PIN    11
#define EPD_RES_PIN   12
#define EPD_BUSY_PIN  13

// SD Card pins (shares SPI bus with ePaper)
#define SD_MISO_PIN   8
#define SD_CS_PIN     14
#define SD_DET_PIN    15   // Card detection (LOW = card inserted)
#define SD_EN_PIN     16   // Power enable for SD card slot

// Battery monitoring
#define BATTERY_ADC_PIN    1    // GPIO1 - Battery voltage ADC
#define BATTERY_ENABLE_PIN 21   // GPIO21 - Battery monitoring enable

// Buttons (active LOW, internal pull-up)
#define GREEN_BUTTON       3    // Center green - wake + setup mode
#define WHITE_BUTTON_RIGHT 4    // Right white - wake / next image
#define WHITE_BUTTON_LEFT  5    // Left white - wake / next image

// Serial debug (UART1)
#define SERIAL_RX     44
#define SERIAL_TX     43

// =============================================================================
// Display Configuration
// =============================================================================

#define SCREEN_WIDTH  800
#define SCREEN_HEIGHT 480

#define GxEPD2_DISPLAY_CLASS GxEPD2_7C
#define GxEPD2_DRIVER_CLASS  GxEPD2_730c_GDEP073E01

// Buffer for paged drawing. The 7-color display uses 4 bits per pixel,
// so each page row costs WIDTH/2 bytes. 16KB gives us 40 rows per page
// (12 pages total), which fits comfortably in DRAM alongside WiFi/WebServer.
#define MAX_DISPLAY_BUFFER_SIZE 16000

// For GxEPD2_7C (4 bits/pixel): buffer = WIDTH * HEIGHT / 2
// So max_height = buffer_size * 2 / WIDTH
#define MAX_HEIGHT(EPD) \
  (EPD::HEIGHT <= (MAX_DISPLAY_BUFFER_SIZE * 2) / EPD::WIDTH \
    ? EPD::HEIGHT \
    : (MAX_DISPLAY_BUFFER_SIZE * 2) / EPD::WIDTH)

// =============================================================================
// Battery Constants
// =============================================================================

#define BATTERY_FULL_VOLTAGE   4.2f
#define BATTERY_EMPTY_VOLTAGE  3.0f
#define VOLTAGE_DIVIDER_RATIO  2.0f
#define ADC_REFERENCE_VOLTAGE  3.3f
#define ADC_RESOLUTION         4095.0f

// =============================================================================
// Config
// =============================================================================

#define DEFAULT_IMAGE_COUNT    0
#define DEFAULT_DISPLAY_TIME   3600
#define CONFIG_PATH            "/config.txt"
#define IMAGES_FOLDER          "/images"

// =============================================================================
// Wi-Fi Setup Mode Constants
// =============================================================================

#define AP_SSID     "PhotoFrame"
#define AP_PASSWORD "photoframe"
#define AP_CHANNEL  1
#define WEB_PORT    80

// How long to hold green button on boot to enter setup mode (ms)
#define SETUP_HOLD_TIME 3000

// Wake action enum (must be defined before any function that uses it)
enum WakeAction {
  WAKE_NEXT,       // Timer or green button or right white button
  WAKE_PREVIOUS,   // Left white button (sequential mode only)
  WAKE_SETUP       // Green button held (handled earlier in setup())
};

// =============================================================================
// Global Objects
// =============================================================================

SPIClass hspi(HSPI);

GxEPD2_DISPLAY_CLASS<GxEPD2_DRIVER_CLASS, MAX_HEIGHT(GxEPD2_DRIVER_CLASS)>
  display(GxEPD2_DRIVER_CLASS(EPD_CS_PIN, EPD_DC_PIN, EPD_RES_PIN, EPD_BUSY_PIN));

PNG png;

WebServer server(WEB_PORT);

// Config values
int  imageCount    = DEFAULT_IMAGE_COUNT;
int  displayTime   = DEFAULT_DISPLAY_TIME;
bool sequentialMode = false;  // false=random, true=sequential

// RTC memory survives deep sleep
RTC_DATA_ATTR int lastImageIndex = -1;
RTC_DATA_ATTR int sequentialIndex = 0;  // Current position in sequential mode (0-based)

// File handle for PNG decoder callback
File pngFile;

// PSRAM frame buffer: stores palette color index per pixel.
// Decoded from PNG first, then drawn to display during paged refresh.
// This avoids SD card SPI conflicts during paged ePaper drawing.
// 800 * 480 = 384,000 bytes in PSRAM (we have 8MB).
uint8_t *frameBuffer = NULL;

// =============================================================================
// PNG Decoder Callbacks
// =============================================================================

void *pngOpen(const char *filename, int32_t *size) {
  if (pngFile) pngFile.close();  // Close any previously leaked handle
  pngFile = SD.open(filename, FILE_READ);
  if (!pngFile) return NULL;
  *size = pngFile.size();
  return &pngFile;
}

void pngClose(void *handle) {
  if (pngFile) pngFile.close();
}

int32_t pngRead(PNGFILE *handle, uint8_t *buffer, int32_t length) {
  if (!pngFile) return 0;
  return pngFile.read(buffer, length);
}

int32_t pngSeek(PNGFILE *handle, int32_t position) {
  if (!pngFile) return 0;
  return pngFile.seek(position);
}

// Palette index constants for the frame buffer (uint8_t safe)
#define PAL_BLACK  0
#define PAL_WHITE  1
#define PAL_GREEN  2
#define PAL_BLUE   3
#define PAL_RED    4
#define PAL_YELLOW 5
#define PAL_ORANGE 6

// Lookup table: palette index → GxEPD2 16-bit color constant
static const uint16_t PALETTE_TO_EPD[] = {
  GxEPD_BLACK, GxEPD_WHITE, GxEPD_GREEN, GxEPD_BLUE,
  GxEPD_RED, GxEPD_YELLOW, GxEPD_ORANGE
};

// RGB values for each palette entry (for nearest-color matching)
static const uint8_t PALETTE_RGB[][3] = {
  {   0,   0,   0 },  // BLACK
  { 255, 255, 255 },  // WHITE
  {   0, 255,   0 },  // GREEN
  {   0,   0, 255 },  // BLUE
  { 255,   0,   0 },  // RED
  { 255, 255,   0 },  // YELLOW
  { 255, 128,   0 },  // ORANGE
};

/**
 * Find nearest palette index (0-6) for an RGB color.
 * Returns a uint8_t that can safely be stored in the frame buffer.
 */
uint8_t findNearestPaletteIndex(uint8_t r, uint8_t g, uint8_t b) {
  uint32_t minDist = UINT32_MAX;
  uint8_t bestIdx = PAL_WHITE;
  for (int i = 0; i < 7; i++) {
    int32_t dr = (int32_t)r - PALETTE_RGB[i][0];
    int32_t dg = (int32_t)g - PALETTE_RGB[i][1];
    int32_t db = (int32_t)b - PALETTE_RGB[i][2];
    uint32_t dist = dr * dr + dg * dg + db * db;
    if (dist < minDist) { minDist = dist; bestIdx = i; }
  }
  return bestIdx;
}

int pngDraw(PNGDRAW *pDraw) {
  uint16_t usPixels[SCREEN_WIDTH];
  png.getLineAsRGB565(pDraw, usPixels, PNG_RGB565_LITTLE_ENDIAN, 0xffffffff);
  if (frameBuffer && pDraw->y < SCREEN_HEIGHT) {
    int offset = pDraw->y * SCREEN_WIDTH;
    for (int x = 0; x < pDraw->iWidth && x < SCREEN_WIDTH; x++) {
      uint16_t pixel = usPixels[x];
      uint8_t r = ((pixel >> 11) & 0x1F) << 3;
      uint8_t g = ((pixel >> 5)  & 0x3F) << 2;
      uint8_t b = ( pixel        & 0x1F) << 3;
      frameBuffer[offset + x] = findNearestPaletteIndex(r, g, b);
    }
  }
  return 1;
}

// =============================================================================
// SD Card Functions
// =============================================================================

bool initSD() {
  pinMode(SD_EN_PIN, OUTPUT);

  // Try mounting the SD card with retries and power cycling.
  // After ESP.restart(), the card may be in an inconsistent state
  // and needs a full power cycle to recover.
  const int maxRetries = 3;

  for (int attempt = 1; attempt <= maxRetries; attempt++) {
    Serial1.printf("SD init attempt %d/%d...\n", attempt, maxRetries);

    // Power cycle the SD card slot
    digitalWrite(SD_EN_PIN, LOW);
    delay(200);  // Let power fully drain
    digitalWrite(SD_EN_PIN, HIGH);
    delay(300);  // Let card power up and stabilize

    // Ensure display CS is deselected so SD has exclusive SPI bus
    digitalWrite(EPD_CS_PIN, HIGH);

    if (SD.begin(SD_CS_PIN, hspi)) {
      Serial1.println("SD Card mounted.");
      if (!SD.exists(IMAGES_FOLDER)) {
        SD.mkdir(IMAGES_FOLDER);
      }
      return true;
    }

    Serial1.printf("SD mount attempt %d failed.\n", attempt);
    SD.end();  // Clean up before retry
    delay(200);
  }

  Serial1.println("SD Card mount failed after all retries!");
  return false;
}

void deinitSD() {
  SD.end();
  digitalWrite(SD_EN_PIN, LOW);
}

// =============================================================================
// Count images actually present on SD card
// =============================================================================

int countImagesOnSD() {
  int count = 0;
  for (int i = 1; i <= 999; i++) {
    String path = String(IMAGES_FOLDER) + "/" + String(i) + ".png";
    if (SD.exists(path)) {
      count = i;
    } else {
      break;
    }
  }
  return count;
}

// =============================================================================
// Configuration
// =============================================================================

void writeConfig(int imgCount, int dispTime) {
  if (SD.exists(CONFIG_PATH)) {
    SD.remove(CONFIG_PATH);
  }
  File f = SD.open(CONFIG_PATH, FILE_WRITE);
  if (f) {
    f.printf("image_count=%d\n", imgCount);
    f.printf("display_time=%d\n", dispTime);
    f.printf("display_order=%s\n", sequentialMode ? "sequential" : "random");
    f.close();
  }
  imageCount = imgCount;
  displayTime = dispTime;
}

bool readConfig() {
  File configFile = SD.open(CONFIG_PATH, FILE_READ);
  if (!configFile) {
    Serial1.println("config.txt not found, using defaults.");
    return false;
  }
  while (configFile.available()) {
    String line = configFile.readStringUntil('\n');
    line.trim();
    if (line.length() == 0 || line.startsWith("#") || line.startsWith("//")) continue;
    int eqPos = line.indexOf('=');
    if (eqPos < 0) continue;
    String key   = line.substring(0, eqPos);   key.trim();
    String value = line.substring(eqPos + 1);   value.trim();
    if (key == "image_count") {
      imageCount = value.toInt();
      if (imageCount < 0) imageCount = DEFAULT_IMAGE_COUNT;
    } else if (key == "display_time") {
      displayTime = value.toInt();
      if (displayTime < 10) displayTime = DEFAULT_DISPLAY_TIME;
    } else if (key == "display_order") {
      sequentialMode = (value == "sequential");
    }
  }
  configFile.close();
  Serial1.printf("Config: image_count=%d, display_time=%d, order=%s\n",
                 imageCount, displayTime, sequentialMode ? "sequential" : "random");
  return true;
}

// =============================================================================
// Battery
// =============================================================================

int getBatteryPercent() {
  pinMode(BATTERY_ENABLE_PIN, OUTPUT);
  digitalWrite(BATTERY_ENABLE_PIN, HIGH);
  delay(50);
  uint32_t adcSum = 0;
  for (int i = 0; i < 16; i++) {
    adcSum += analogRead(BATTERY_ADC_PIN);
    delay(5);
  }
  uint32_t adcValue = adcSum / 16;
  digitalWrite(BATTERY_ENABLE_PIN, LOW);
  float voltage = (adcValue / ADC_RESOLUTION) * ADC_REFERENCE_VOLTAGE * VOLTAGE_DIVIDER_RATIO;
  int percent = (int)(((voltage - BATTERY_EMPTY_VOLTAGE) /
                       (BATTERY_FULL_VOLTAGE - BATTERY_EMPTY_VOLTAGE)) * 100.0f);
  if (percent < 0)   percent = 0;
  if (percent > 100)  percent = 100;
  Serial1.printf("Battery: ADC=%d, %.2fV, %d%%\n", adcValue, voltage, percent);
  return percent;
}

// =============================================================================
// Display Functions
// =============================================================================

/**
 * Set up SPI bus pins and chip selects. Must be called before SD or display init.
 */
void initSPI() {
  pinMode(EPD_RES_PIN, OUTPUT);
  pinMode(EPD_DC_PIN, OUTPUT);
  pinMode(EPD_CS_PIN, OUTPUT);
  digitalWrite(EPD_CS_PIN, HIGH);  // Deselect display
  hspi.begin(EPD_SCK_PIN, SD_MISO_PIN, EPD_MOSI_PIN, -1);
}

/**
 * Initialize the ePaper display driver. Call AFTER all SD card reads are done,
 * because display.init() sends SPI commands that can confuse the SD card.
 */
void initDisplay() {
  display.epd2.selectSPI(hspi, SPISettings(2000000, MSBFIRST, SPI_MODE0));
  display.init(0);
  display.setRotation(0);
}

void drawBatteryBar(int percent) {
  int greenWidth = (SCREEN_WIDTH * percent) / 100;
  int y = SCREEN_HEIGHT - 1;
  for (int x = 0; x < SCREEN_WIDTH; x++) {
    display.drawPixel(x, y, (x < greenWidth) ? GxEPD_GREEN : GxEPD_RED);
  }
}

/**
 * Decode a PNG from SD card into the PSRAM frame buffer.
 * Returns true on success. SD card must be mounted before calling.
 * Does NOT deinit SD on failure so caller can retry with another image.
 */
bool decodePNGToBuffer(const char *imagePath) {
  if (!frameBuffer) {
    Serial1.println("Frame buffer not allocated!");
    return false;
  }

  // Verify the file is readable and check PNG header
  File testFile = SD.open(imagePath, FILE_READ);
  if (!testFile) {
    Serial1.printf("Cannot open file: %s\n", imagePath);
    return false;
  }
  size_t fileSize = testFile.size();
  Serial1.printf("File: %s, size: %d bytes\n", imagePath, fileSize);

  // Check PNG magic bytes (89 50 4E 47 = .PNG)
  uint8_t header[8];
  int bytesRead = testFile.read(header, 8);
  testFile.close();

  if (bytesRead < 8 || header[0] != 0x89 || header[1] != 0x50 ||
      header[2] != 0x4E || header[3] != 0x47) {
    Serial1.printf("Not a valid PNG file! Header: %02X %02X %02X %02X\n",
                   header[0], header[1], header[2], header[3]);
    return false;
  }

  memset(frameBuffer, PAL_WHITE, SCREEN_WIDTH * SCREEN_HEIGHT);

  digitalWrite(EPD_CS_PIN, HIGH);

  int rc = png.open(imagePath, pngOpen, pngClose, pngRead, pngSeek, pngDraw);
  if (rc != PNG_SUCCESS) {
    Serial1.printf("PNG open failed for %s: error %d\n", imagePath, rc);
    if (pngFile) pngFile.close();
    return false;
  }

  Serial1.printf("PNG: %dx%d, bpp=%d, type=%d\n",
                 png.getWidth(), png.getHeight(), png.getBpp(), png.getPixelType());

  int decodeResult = png.decode(NULL, 0);
  png.close();

  if (decodeResult != PNG_SUCCESS) {
    Serial1.printf("PNG decode failed for %s: error %d\n", imagePath, decodeResult);
    return false;
  }

  Serial1.printf("PNG decoded successfully: %s\n", imagePath);
  return true;
}

/**
 * Draw the contents of the PSRAM frame buffer to the ePaper display.
 * SD card should already be deinited and display should be inited before calling.
 */
void drawBufferToDisplay(int batteryPercent) {
  display.setFullWindow();
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);

    for (int y = 0; y < SCREEN_HEIGHT; y++) {
      int offset = y * SCREEN_WIDTH;
      for (int x = 0; x < SCREEN_WIDTH; x++) {
        uint8_t palIdx = frameBuffer[offset + x];
        if (palIdx != PAL_WHITE) {
          display.drawPixel(x, y, PALETTE_TO_EPD[palIdx]);
        }
      }
    }

    drawBatteryBar(batteryPercent);
  } while (display.nextPage());

  Serial1.println("Display updated.");
}

// =============================================================================
// Setup Mode: ePaper Instructions Screen
// =============================================================================

void displaySetupScreen(int batteryPercent, int photoCount) {
  display.setFullWindow();
  display.firstPage();

  do {
    display.fillScreen(GxEPD_WHITE);

    // ── Title bar ──
    display.fillRect(0, 0, SCREEN_WIDTH, 62, GxEPD_BLUE);
    display.setFont(&FreeSansBold24pt7b);
    display.setTextColor(GxEPD_WHITE);
    display.setCursor(180, 46);
    display.print("Photo Frame Setup");

    // ── Thin accent line under title ──
    display.fillRect(0, 62, SCREEN_WIDTH, 3, GxEPD_RED);

    // ── Battery indicator (top-right, inside title bar) ──
    display.setFont(&FreeSans9pt7b);
    display.setTextColor(GxEPD_WHITE);
    {
      char batBuf[20];
      snprintf(batBuf, sizeof(batBuf), "%d%%", batteryPercent);
      // Draw small battery icon outline
      int bx = SCREEN_WIDTH - 80, by = 22;
      display.drawRect(bx, by, 30, 16, GxEPD_WHITE);
      display.fillRect(bx + 30, by + 4, 3, 8, GxEPD_WHITE);
      int fillW = (26 * batteryPercent) / 100;
      if (fillW > 0) display.fillRect(bx + 2, by + 2, fillW, 12, GxEPD_WHITE);
      display.setCursor(bx - 35, by + 14);
      display.print(batBuf);
    }

    int y = 92;
    int stepNumX = 30;
    int stepTextX = 155;

    // ── Step 1 ──
    display.setFont(&FreeSansBold18pt7b);
    display.setTextColor(GxEPD_BLUE);
    display.setCursor(stepNumX, y);
    display.print("1.");
    display.setTextColor(GxEPD_BLACK);
    display.setFont(&FreeSansBold12pt7b);
    display.setCursor(stepTextX, y);
    display.print("On your phone, open Wi-Fi settings");

    y += 52;

    // ── Step 2 ──
    display.setFont(&FreeSansBold18pt7b);
    display.setTextColor(GxEPD_BLUE);
    display.setCursor(stepNumX, y);
    display.print("2.");
    display.setTextColor(GxEPD_BLACK);
    display.setFont(&FreeSansBold12pt7b);
    display.setCursor(stepTextX, y);
    display.print("Connect to this network:");

    y += 18;

    // Wi-Fi credentials box with filled background
    int boxY = y;
    int boxH = 72;
    display.fillRoundRect(65, boxY, 670, boxH, 6, GxEPD_BLUE);

    display.setFont(&FreeSansBold18pt7b);
    display.setTextColor(GxEPD_WHITE);
    display.setCursor(90, boxY + 30);
    display.print("Wi-Fi:  ");
    display.print(AP_SSID);

    display.setCursor(90, boxY + 62);
    display.print("Password:  ");
    display.print(AP_PASSWORD);

    y = boxY + boxH + 30;

    // ── Step 3 ──
    display.setFont(&FreeSansBold18pt7b);
    display.setTextColor(GxEPD_BLUE);
    display.setCursor(stepNumX, y);
    display.print("3.");
    display.setTextColor(GxEPD_BLACK);
    display.setFont(&FreeSansBold12pt7b);
    display.setCursor(stepTextX, y);
    display.print("Open your browser and visit:");

    y += 18;

    // URL box - prominent green border with large text
    int urlBoxY = y;
    display.fillRoundRect(65, urlBoxY, 670, 52, 6, GxEPD_GREEN);
    display.setFont(&FreeSansBold24pt7b);
    display.setTextColor(GxEPD_WHITE);
    display.setCursor(130, urlBoxY + 40);
    display.print("http://192.168.4.1");

    y = urlBoxY + 75;

    // ── Step 4 ──
    display.setFont(&FreeSansBold18pt7b);
    display.setTextColor(GxEPD_BLUE);
    display.setCursor(stepNumX, y);
    display.print("4.");
    display.setTextColor(GxEPD_BLACK);
    display.setFont(&FreeSansBold12pt7b);
    display.setCursor(stepTextX, y);
    display.print("Upload photos and tap Start Slideshow");

    // ── Footer ──
    display.drawFastHLine(30, 435, SCREEN_WIDTH - 60, GxEPD_BLACK);

    display.setFont(&FreeSans9pt7b);
    display.setTextColor(GxEPD_BLACK);
    {
      char infoBuf[80];
      snprintf(infoBuf, sizeof(infoBuf), "%d photo%s loaded   |   Press green button when done",
               photoCount, (photoCount != 1) ? "s" : "");
      display.setCursor(30, 458);
      display.print(infoBuf);
    }

    drawBatteryBar(batteryPercent);

  } while (display.nextPage());
}

void displayStartingScreen(int photoCount, int intervalMinutes) {
  display.setFullWindow();
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);

    display.fillRect(0, 0, SCREEN_WIDTH, 58, GxEPD_GREEN);
    display.setFont(&FreeSansBold24pt7b);
    display.setTextColor(GxEPD_WHITE);
    display.setCursor(100, 44);
    display.print("Starting Slideshow!");

    display.setFont(&FreeSansBold18pt7b);
    display.setTextColor(GxEPD_BLACK);

    int y = 140;
    {
      char buf[80];
      snprintf(buf, sizeof(buf), "%d photos loaded", photoCount);
      display.setCursor(200, y);
      display.print(buf);
    }

    y += 60;
    {
      char buf[80];
      if (intervalMinutes >= 60) {
        snprintf(buf, sizeof(buf), "Changing every %d hour%s",
                 intervalMinutes / 60, (intervalMinutes / 60 > 1) ? "s" : "");
      } else {
        snprintf(buf, sizeof(buf), "Changing every %d minute%s",
                 intervalMinutes, (intervalMinutes > 1) ? "s" : "");
      }
      display.setCursor(150, y);
      display.print(buf);
    }

    y += 80;
    display.setFont(&FreeSansBold12pt7b);
    display.setTextColor(GxEPD_BLUE);
    display.setCursor(60, y);
    display.print("To add or change photos later, hold the green");
    display.setCursor(60, y + 30);
    display.print("button while turning on the power switch.");

    y += 90;
    display.setFont(&FreeSans9pt7b);
    display.setTextColor(GxEPD_BLACK);
    display.setCursor(180, y);
    display.print("The first photo will appear shortly...");

  } while (display.nextPage());
}

void displayError(const char *msg) {
  display.setFullWindow();
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);

    display.fillRect(0, 0, SCREEN_WIDTH, 58, GxEPD_RED);
    display.setFont(&FreeSansBold24pt7b);
    display.setTextColor(GxEPD_WHITE);
    display.setCursor(300, 44);
    display.print("Error");

    display.setFont(&FreeSansBold12pt7b);
    display.setTextColor(GxEPD_BLACK);
    display.setCursor(40, 140);
    display.print(msg);

    display.setFont(&FreeSans9pt7b);
    display.setCursor(40, 280);
    display.print("Please turn the power off and on again.");
    display.setCursor(40, 305);
    display.print("Hold the green button during power-on to enter setup mode.");
  } while (display.nextPage());
}

void displayNoPhotos() {
  display.setFullWindow();
  display.firstPage();
  do {
    display.fillScreen(GxEPD_WHITE);

    display.setFont(&FreeSansBold24pt7b);
    display.setTextColor(GxEPD_BLACK);
    display.setCursor(140, 180);
    display.print("No Photos Yet!");

    display.setFont(&FreeSansBold12pt7b);
    display.setTextColor(GxEPD_BLUE);
    display.setCursor(80, 260);
    display.print("To add photos, turn the device off and on");
    display.setCursor(80, 290);
    display.print("while holding the green button.");

    display.setFont(&FreeSans9pt7b);
    display.setTextColor(GxEPD_BLACK);
    display.setCursor(120, 370);
    display.print("This will open the photo upload Wi-Fi setup screen.");

  } while (display.nextPage());
}

// =============================================================================
// Web Server: HTML Page (stored in flash)
// =============================================================================

const char WEBPAGE_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Photo Frame Setup</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f0f4f8; color: #333; padding: 16px; max-width: 600px; margin: 0 auto;
  }
  h1 { text-align: center; color: #2563eb; margin: 16px 0 8px; font-size: 24px; }
  .subtitle { text-align: center; color: #64748b; margin-bottom: 20px; font-size: 14px; }
  .card {
    background: white; border-radius: 12px; padding: 20px;
    margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }
  .card h2 { font-size: 18px; margin-bottom: 12px; color: #1e293b; }
  .drop-zone {
    border: 3px dashed #93c5fd; border-radius: 12px; padding: 40px 20px;
    text-align: center; cursor: pointer; transition: all 0.2s; background: #eff6ff;
  }
  .drop-zone:hover, .drop-zone.drag-over { border-color: #2563eb; background: #dbeafe; }
  .drop-zone .icon { font-size: 48px; margin-bottom: 8px; }
  .drop-zone p { font-size: 16px; color: #475569; }
  .drop-zone .hint { font-size: 12px; color: #94a3b8; margin-top: 4px; }
  #fileInput { display: none; }
  .progress-bar {
    width: 100%; height: 8px; background: #e2e8f0; border-radius: 4px;
    margin-top: 12px; display: none; overflow: hidden;
  }
  .progress-bar .fill {
    height: 100%; background: #2563eb; border-radius: 4px;
    transition: width 0.3s; width: 0%;
  }
  .upload-status {
    text-align: center; margin-top: 8px; font-size: 14px; color: #475569; display: none;
  }
  .photo-list { list-style: none; }
  .photo-list li {
    display: flex; justify-content: space-between; align-items: center;
    padding: 10px 0; border-bottom: 1px solid #f1f5f9;
  }
  .photo-list li:last-child { border-bottom: none; }
  .photo-name { font-size: 15px; color: #334155; }
  .photo-size { font-size: 12px; color: #94a3b8; margin-left: 8px; }
  .btn-delete {
    background: #fee2e2; color: #dc2626; border: none; border-radius: 8px;
    padding: 6px 14px; cursor: pointer; font-size: 13px; font-weight: 500;
  }
  .btn-delete:hover { background: #fecaca; }
  .empty-msg { text-align: center; color: #94a3b8; padding: 20px; font-size: 14px; }
  .setting-row {
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;
  }
  .setting-row label { font-size: 15px; color: #475569; }
  .setting-row select {
    padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px;
    font-size: 15px; background: white; width: 180px;
  }
  .btn-start {
    display: block; width: 100%; padding: 16px; background: #16a34a;
    color: white; border: none; border-radius: 12px; font-size: 18px;
    font-weight: 600; cursor: pointer; margin-top: 8px; letter-spacing: 0.5px;
  }
  .btn-start:hover { background: #15803d; }
  .btn-start:disabled { background: #94a3b8; cursor: not-allowed; }
  .btn-save {
    padding: 10px 20px; background: #2563eb; color: white; border: none;
    border-radius: 8px; font-size: 14px; cursor: pointer;
  }
  .btn-save:hover { background: #1d4ed8; }
  .info-box {
    background: #eff6ff; border-left: 4px solid #2563eb; padding: 12px 16px;
    border-radius: 0 8px 8px 0; margin-bottom: 16px; font-size: 13px;
    color: #1e40af; line-height: 1.5;
  }
  .photo-count {
    text-align: center; font-size: 14px; color: #64748b; margin-top: 4px;
  }
</style>
</head>
<body>

<h1>&#128247; Photo Frame Setup</h1>
<p class="subtitle">Add your photos and start the slideshow</p>

<div class="info-box">
  <strong>Image requirements:</strong> PNG format, 800 x 480 pixels.
  For best results, use images already converted for the 6-colour e-ink
  palette (black, white, red, green, blue, yellow).
</div>

<div class="card">
  <h2>&#128228; Upload Photos</h2>
  <div class="drop-zone" id="dropZone" onclick="document.getElementById('fileInput').click()">
    <div class="icon">&#128206;</div>
    <p>Tap here to choose photos</p>
    <p class="hint">or drag and drop PNG files here</p>
  </div>
  <input type="file" id="fileInput" accept=".png,image/png" multiple>
  <div class="progress-bar" id="progressBar"><div class="fill" id="progressFill"></div></div>
  <div class="upload-status" id="uploadStatus"></div>
</div>

<div class="card">
  <h2>&#128247; Your Photos</h2>
  <p class="photo-count" id="photoCount"></p>
  <ul class="photo-list" id="photoList"></ul>
</div>

<div class="card">
  <h2>&#9881;&#65039; Settings</h2>
  <div class="setting-row">
    <label>Change photo every:</label>
    <select id="interval">
      <option value="60">1 minute</option>
      <option value="300">5 minutes</option>
      <option value="600">10 minutes</option>
      <option value="1800">30 minutes</option>
      <option value="3600" selected>1 hour</option>
      <option value="7200">2 hours</option>
      <option value="14400">4 hours</option>
      <option value="21600">6 hours</option>
      <option value="43200">12 hours</option>
      <option value="86400">24 hours</option>
    </select>
  </div>
  <div class="setting-row">
    <label>Display order:</label>
    <select id="displayOrder">
      <option value="random">Random</option>
      <option value="sequential">Sequential (1, 2, 3...)</option>
    </select>
  </div>
  <div id="seqHint" style="font-size:12px;color:#64748b;margin:-4px 0 8px 0;display:none">
    Use the left/right white buttons to go back/forward.
  </div>
  <div style="text-align:center; margin-top:8px">
    <button class="btn-save" onclick="saveSettings()">Save Settings</button>
  </div>
</div>

<button class="btn-start" id="btnStart" onclick="startSlideshow()">
  &#9654;&#65039; Start Slideshow
</button>

<script>
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const uploadStatus = document.getElementById('uploadStatus');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

async function handleFiles(files) {
  const pngFiles = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.png'));
  if (pngFiles.length === 0) { alert('Please select PNG files only.'); return; }

  progressBar.style.display = 'block';
  uploadStatus.style.display = 'block';

  for (let i = 0; i < pngFiles.length; i++) {
    uploadStatus.textContent = 'Uploading ' + (i + 1) + ' of ' + pngFiles.length + ': ' + pngFiles[i].name;
    progressFill.style.width = ((i / pngFiles.length) * 100) + '%';

    const formData = new FormData();
    formData.append('file', pngFiles[i]);

    try {
      const resp = await fetch('/upload', { method: 'POST', body: formData });
      const result = await resp.json();
      if (!result.ok) alert('Upload failed: ' + (result.error || 'Unknown error'));
    } catch (err) {
      alert('Upload error: ' + err.message);
    }
  }

  progressFill.style.width = '100%';
  uploadStatus.textContent = 'Done! Uploaded ' + pngFiles.length + ' photo(s).';
  setTimeout(() => {
    progressBar.style.display = 'none';
    uploadStatus.style.display = 'none';
    progressFill.style.width = '0%';
  }, 2000);

  fileInput.value = '';
  loadPhotos();
}

async function loadPhotos() {
  try {
    const resp = await fetch('/list');
    const data = await resp.json();
    const list = document.getElementById('photoList');
    const count = document.getElementById('photoCount');
    list.innerHTML = '';

    if (data.files.length === 0) {
      list.innerHTML = '<div class="empty-msg">No photos yet. Upload some above!</div>';
      count.textContent = '0 photos';
      document.getElementById('btnStart').disabled = true;
    } else {
      count.textContent = data.files.length + ' photo' + (data.files.length !== 1 ? 's' : '');
      document.getElementById('btnStart').disabled = false;
      data.files.forEach(f => {
        const li = document.createElement('li');
        const info = document.createElement('span');
        info.innerHTML = '<span class="photo-name">' + f.name + '</span>' +
                         '<span class="photo-size">' + formatSize(f.size) + '</span>';
        const btn = document.createElement('button');
        btn.className = 'btn-delete';
        btn.textContent = 'Delete';
        btn.onclick = () => deletePhoto(f.name);
        li.appendChild(info);
        li.appendChild(btn);
        list.appendChild(li);
      });
    }

    if (data.display_time) {
      document.getElementById('interval').value = data.display_time;
    }
    if (data.display_order) {
      document.getElementById('displayOrder').value = data.display_order;
      updateOrderHint();
    }
  } catch (err) {
    console.error('Failed to load photos:', err);
  }
}

function updateOrderHint() {
  var sel = document.getElementById('displayOrder');
  document.getElementById('seqHint').style.display =
    sel.value === 'sequential' ? 'block' : 'none';
}
document.getElementById('displayOrder').addEventListener('change', updateOrderHint);

async function deletePhoto(name) {
  if (!confirm('Delete ' + name + '?')) return;
  try {
    await fetch('/delete?name=' + encodeURIComponent(name));
    loadPhotos();
  } catch (err) { alert('Delete failed: ' + err.message); }
}

async function saveSettings() {
  const interval = document.getElementById('interval').value;
  const order = document.getElementById('displayOrder').value;
  try {
    const resp = await fetch('/settings?display_time=' + interval + '&display_order=' + order);
    const data = await resp.json();
    if (data.ok) alert('Settings saved!');
  } catch (err) { alert('Save failed: ' + err.message); }
}

async function startSlideshow() {
  if (!confirm('Start the slideshow? The setup screen will close.')) return;
  document.getElementById('btnStart').disabled = true;
  document.getElementById('btnStart').textContent = 'Starting...';
  try { await fetch('/start'); } catch (err) { /* device reboots */ }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

loadPhotos();
</script>
</body>
</html>
)rawliteral";

// =============================================================================
// Web Server: Route Handlers
// =============================================================================

void handleRoot() {
  server.send(200, "text/html", WEBPAGE_HTML);
}

void handleList() {
  int count = countImagesOnSD();
  String json = "{\"files\":[";
  for (int i = 1; i <= count; i++) {
    String path = String(IMAGES_FOLDER) + "/" + String(i) + ".png";
    File f = SD.open(path, FILE_READ);
    if (f) {
      if (i > 1) json += ",";
      json += "{\"name\":\"" + String(i) + ".png\",\"size\":" + String(f.size()) + "}";
      f.close();
    }
  }
  json += "],\"display_time\":" + String(displayTime) + 
          ",\"image_count\":" + String(count) + 
          ",\"display_order\":\"" + String(sequentialMode ? "sequential" : "random") + "\"}";
  server.send(200, "application/json", json);
}

// Static vars for chunked upload
static File uploadFile;
static String uploadPath;

void handleUploadChunk() {
  HTTPUpload& upload = server.upload();

  if (upload.status == UPLOAD_FILE_START) {
    int nextNum = countImagesOnSD() + 1;
    uploadPath = String(IMAGES_FOLDER) + "/" + String(nextNum) + ".png";
    Serial1.printf("Upload start: %s -> %s\n", upload.filename.c_str(), uploadPath.c_str());
    uploadFile = SD.open(uploadPath, FILE_WRITE);
  }
  else if (upload.status == UPLOAD_FILE_WRITE) {
    if (uploadFile) {
      uploadFile.write(upload.buf, upload.currentSize);
    }
  }
  else if (upload.status == UPLOAD_FILE_END) {
    if (uploadFile) {
      uploadFile.close();
      Serial1.printf("Upload done: %s (%d bytes)\n", uploadPath.c_str(), upload.totalSize);
      int newCount = countImagesOnSD();
      writeConfig(newCount, displayTime);
    }
  }
}

void handleUploadComplete() {
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleDelete() {
  String name = server.arg("name");
  String path = String(IMAGES_FOLDER) + "/" + name;

  Serial1.printf("Delete: %s\n", path.c_str());

  if (!SD.exists(path)) {
    server.send(404, "application/json", "{\"ok\":false,\"error\":\"File not found\"}");
    return;
  }

  SD.remove(path);

  // Renumber remaining files to close the gap
  int total = 0;
  for (int i = 1; i <= 999; i++) {
    String checkPath = String(IMAGES_FOLDER) + "/" + String(i) + ".png";
    if (SD.exists(checkPath)) {
      total = i;
    } else if (total > 0) {
      break;  // Past the last file
    }
  }

  // Compact: slide files down to fill gaps
  int writePos = 1;
  for (int readPos = 1; readPos <= total; readPos++) {
    String srcPath = String(IMAGES_FOLDER) + "/" + String(readPos) + ".png";
    if (SD.exists(srcPath)) {
      if (readPos != writePos) {
        String dstPath = String(IMAGES_FOLDER) + "/" + String(writePos) + ".png";
        File src = SD.open(srcPath, FILE_READ);
        File dst = SD.open(dstPath, FILE_WRITE);
        if (src && dst) {
          uint8_t buf[512];
          while (src.available()) {
            int bytesRead = src.read(buf, sizeof(buf));
            dst.write(buf, bytesRead);
          }
          dst.close();
          src.close();
          SD.remove(srcPath);
        }
      }
      writePos++;
    }
  }

  int newCount = countImagesOnSD();
  writeConfig(newCount, displayTime);
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleSettings() {
  if (server.hasArg("display_time")) {
    int newTime = server.arg("display_time").toInt();
    if (newTime >= 10) {
      displayTime = newTime;
    }
  }
  if (server.hasArg("display_order")) {
    String order = server.arg("display_order");
    sequentialMode = (order == "sequential");
    sequentialIndex = 0;  // Reset position when mode changes
  }
  writeConfig(imageCount, displayTime);
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleStart() {
  int finalCount = countImagesOnSD();
  writeConfig(finalCount, displayTime);

  server.send(200, "application/json", "{\"ok\":true}");
  delay(500);

  server.close();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_OFF);

  // Show transition screen while SD is still available
  initDisplay();
  displayStartingScreen(finalCount, displayTime / 60);

  // Shut everything down and deep sleep for 2 seconds.
  // Waking from deep sleep is a true cold boot (full hardware reset),
  // which avoids the SD card SPI issues caused by ESP.restart().
  deinitSD();
  display.hibernate();
  esp_sleep_enable_timer_wakeup(2 * 1000000ULL);  // 2 seconds
  esp_deep_sleep_start();
}

// =============================================================================
// Setup Mode Main Loop
// =============================================================================

void runSetupMode() {
  Serial1.println("=== SETUP MODE ===");

  int photoCount = countImagesOnSD();
  int batteryPercent = getBatteryPercent();

  // Start Wi-Fi AP
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD, AP_CHANNEL, false, 4);
  delay(500);

  IPAddress ip = WiFi.softAPIP();
  Serial1.printf("AP: %s / %s\n", AP_SSID, AP_PASSWORD);
  Serial1.printf("IP: %s\n", ip.toString().c_str());

  // Show instructions on ePaper
  displaySetupScreen(batteryPercent, photoCount);

  // Configure web server routes
  server.on("/", HTTP_GET, handleRoot);
  server.on("/list", HTTP_GET, handleList);
  server.on("/upload", HTTP_POST, handleUploadComplete, handleUploadChunk);
  server.on("/delete", HTTP_GET, handleDelete);
  server.on("/settings", HTTP_GET, handleSettings);
  server.on("/start", HTTP_GET, handleStart);

  server.begin();
  Serial1.println("Web server started on port 80");

  // Run until user presses green button or clicks "Start Slideshow" on web page
  while (true) {
    server.handleClient();

    // Check for green button press to exit setup
    if (digitalRead(GREEN_BUTTON) == LOW) {
      delay(50);  // Debounce
      if (digitalRead(GREEN_BUTTON) == LOW) {
        // Wait for release
        while (digitalRead(GREEN_BUTTON) == LOW) {
          delay(10);
          server.handleClient();
        }

        Serial1.println("Green button - exiting setup");

        int finalCount = countImagesOnSD();
        writeConfig(finalCount, displayTime);

        server.close();
        WiFi.softAPdisconnect(true);
        WiFi.mode(WIFI_OFF);

        // Show transition screen while SD is still available
        initDisplay();
        displayStartingScreen(finalCount, displayTime / 60);

        // Deep sleep for 2 seconds → true cold boot → SD inits cleanly
        deinitSD();
        display.hibernate();
        esp_sleep_enable_timer_wakeup(2 * 1000000ULL);
        esp_deep_sleep_start();
      }
    }

    delay(2);
  }
}

// =============================================================================
// Wake Source Detection
// =============================================================================

/**
 * Determine what action to take based on how the device woke up.
 * In sequential mode, left/right white buttons go backward/forward.
 * In random mode, all wakes just pick a new random image.
 */
WakeAction getWakeAction() {
  esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();

  if (cause == ESP_SLEEP_WAKEUP_EXT1 && sequentialMode) {
    // An ext1 button woke us - check which one is still pressed
    // Read immediately; the button should still be held briefly
    delay(10);  // Small delay for GPIO to settle
    bool rightPressed = (digitalRead(WHITE_BUTTON_RIGHT) == LOW);
    bool leftPressed  = (digitalRead(WHITE_BUTTON_LEFT) == LOW);

    Serial1.printf("Ext1 wake: right=%d, left=%d\n", rightPressed, leftPressed);

    if (leftPressed && !rightPressed) {
      return WAKE_PREVIOUS;
    }
    // Right button or both = next
    return WAKE_NEXT;
  }

  // Timer, green button, ext1 in random mode, or cold boot = next
  return WAKE_NEXT;
}

// =============================================================================
// Image Selection
// =============================================================================

/**
 * Pick the next image index based on mode and direction.
 * Returns 1-based image index.
 */
int pickNextImage(WakeAction action) {
  if (imageCount <= 0) return 0;
  if (imageCount == 1) return 1;

  if (sequentialMode) {
    // Sequential mode: step forward or backward
    if (action == WAKE_PREVIOUS) {
      sequentialIndex--;
      if (sequentialIndex < 0) sequentialIndex = imageCount - 1;  // Wrap to last
    } else {
      sequentialIndex++;
      if (sequentialIndex >= imageCount) sequentialIndex = 0;  // Wrap to first
    }
    Serial1.printf("Sequential: index=%d (of %d)\n", sequentialIndex, imageCount);
    return sequentialIndex + 1;  // Convert to 1-based
  } else {
    // Random mode: pick random, avoid repeating last
    int newIndex;
    int attempts = 0;
    do {
      newIndex = (esp_random() % imageCount) + 1;
      attempts++;
    } while (newIndex == lastImageIndex && attempts < 10);
    return newIndex;
  }
}

String getImagePath(int index) {
  return String(IMAGES_FOLDER) + "/" + String(index) + ".png";
}

// =============================================================================
// Deep Sleep
// =============================================================================

void enterDeepSleep() {
  Serial1.printf("Deep sleep for %d seconds...\n", displayTime);
  Serial1.flush();
  deinitSD();
  display.hibernate();
  esp_sleep_enable_timer_wakeup((uint64_t)displayTime * 1000000ULL);
  // Green button wakes via ext0 (single pin)
  esp_sleep_enable_ext0_wakeup((gpio_num_t)GREEN_BUTTON, LOW);
  // White buttons wake via ext1 (multiple pins, any LOW triggers wake)
  uint64_t ext1_mask = (1ULL << WHITE_BUTTON_RIGHT) | (1ULL << WHITE_BUTTON_LEFT);
  esp_sleep_enable_ext1_wakeup(ext1_mask, ESP_EXT1_WAKEUP_ANY_LOW);
  esp_deep_sleep_start();
}

// =============================================================================
// Main Entry Point
// =============================================================================

void setup() {
  Serial1.begin(115200, SERIAL_8N1, SERIAL_RX, SERIAL_TX);
  delay(500);
  Serial1.println("\n========================================");
  Serial1.println("reTerminal E1002 Digital Photo Frame");
  Serial1.println("========================================");

  // Configure all buttons (active LOW with internal pull-up)
  pinMode(GREEN_BUTTON, INPUT_PULLUP);
  pinMode(WHITE_BUTTON_RIGHT, INPUT_PULLUP);
  pinMode(WHITE_BUTTON_LEFT, INPUT_PULLUP);

  // Initialize SPI bus pins only (no display init yet - it would disrupt SD)
  initSPI();

  // Initialize SD card first while SPI bus is clean
  if (!initSD()) {
    // SD failed - need display to show error
    initDisplay();
    displayError("SD Card Error! Please insert a FAT32\nformatted MicroSD card (32GB or smaller)\nand restart the device.");
    while (true) { delay(1000); }
  }

  // Read config from SD
  readConfig();

  // ── Decide: setup mode or slideshow mode ──
  bool enterSetup = false;
  int actualCount = countImagesOnSD();

  if (actualCount == 0) {
    Serial1.println("No images found - entering setup mode.");
    enterSetup = true;
  } else {
    if (digitalRead(GREEN_BUTTON) == LOW) {
      Serial1.println("Green button held - checking for setup hold...");
      unsigned long holdStart = millis();
      while (digitalRead(GREEN_BUTTON) == LOW) {
        if (millis() - holdStart >= SETUP_HOLD_TIME) {
          enterSetup = true;
          break;
        }
        delay(10);
      }
    }
  }

  if (enterSetup) {
    // Setup mode needs display for instructions screen
    initDisplay();
    runSetupMode();  // Never returns
  }

  // ── Normal slideshow mode ──
  Serial1.println("=== SLIDESHOW MODE ===");

  imageCount = actualCount;
  if (imageCount <= 0) {
    initDisplay();
    displayNoPhotos();
    enterDeepSleep();
    return;
  }

  // Allocate PSRAM frame buffer once, before the retry loop
  Serial1.printf("Free heap: %d, PSRAM total: %d, PSRAM free: %d\n",
                 ESP.getFreeHeap(), ESP.getPsramSize(), ESP.getFreePsram());

  if (!frameBuffer) {
    if (ESP.getPsramSize() == 0) {
      Serial1.println("ERROR: No PSRAM detected! Enable OPI PSRAM in board settings.");
      deinitSD();
      initDisplay();
      displayError("PSRAM not available!\n\nIn Arduino IDE, go to:\nTools > PSRAM > OPI PSRAM\nthen re-upload the firmware.");
      while (true) { delay(1000); }
    }
    frameBuffer = (uint8_t *)ps_malloc(SCREEN_WIDTH * SCREEN_HEIGHT);
    if (!frameBuffer) {
      Serial1.println("ERROR: PSRAM allocation failed!");
      deinitSD();
      initDisplay();
      displayError("Memory allocation failed!\n\nPSRAM detected but could not\nallocate frame buffer.");
      while (true) { delay(1000); }
    }
    Serial1.printf("Frame buffer allocated: %d bytes in PSRAM\n", SCREEN_WIDTH * SCREEN_HEIGHT);
  }

  int batteryPercent = getBatteryPercent();

  // Determine what triggered this wake (for sequential mode direction)
  WakeAction action = getWakeAction();
  Serial1.printf("Wake action: %s\n",
    action == WAKE_PREVIOUS ? "PREVIOUS" : "NEXT");

  // Try to decode an image, with retries if some PNGs fail
  bool decoded = false;
  int imageIndex = pickNextImage(action);
  int triesLeft = imageCount;  // Try every image before giving up
  int retryDirection = (action == WAKE_PREVIOUS) ? -1 : 1;

  while (!decoded && triesLeft > 0) {
    String imagePath = getImagePath(imageIndex);
    Serial1.printf("Trying image #%d: %s (%d tries left)\n",
                   imageIndex, imagePath.c_str(), triesLeft);

    if (SD.exists(imagePath) && decodePNGToBuffer(imagePath.c_str())) {
      decoded = true;
      lastImageIndex = imageIndex;
      if (sequentialMode) {
        sequentialIndex = imageIndex - 1;
      }
    } else {
      Serial1.printf("Image #%d failed, trying next...\n", imageIndex);
      imageIndex += retryDirection;
      if (imageIndex > imageCount) imageIndex = 1;
      if (imageIndex < 1) imageIndex = imageCount;
      triesLeft--;
    }
  }

  // Done reading SD card - release bus
  deinitSD();

  if (decoded) {
    initDisplay();
    drawBufferToDisplay(batteryPercent);
  } else {
    Serial1.println("All images failed to decode!");
    initDisplay();
    displayError("No compatible photos found.\nPlease upload 800x480 PNG images\nusing the setup mode.");
    delay(5000);
  }

  enterDeepSleep();
}

void loop() {
  // Never reached
}
