// Bluetooth for passkeys from a phone (FIDO hybrid): while a QR code is showing, the phone proves it's
// nearby by advertising a short encrypted message over Bluetooth Low Energy. This scans for it and
// hands each advertisement's service data to JavaScript, which decrypts it. Nothing else is read.

#import <CoreBluetooth/CoreBluetooth.h>
#import <Foundation/Foundation.h>
#include "bridge.h"

@interface ZPScanner : NSObject <CBCentralManagerDelegate>
@property(nonatomic, strong) CBCentralManager *manager;
@property(nonatomic, strong) dispatch_queue_t queue;
@property(nonatomic, strong) NSArray<CBUUID *> *services;
@property(nonatomic) napi_threadsafe_function tsfn;
@property(nonatomic) BOOL stopped;
@end

static ZPScanner *gScanner = nil;

/** Delivers a JSON event string to the JavaScript callback (on the JavaScript thread). */
static void Deliver(napi_env env, napi_value callback, void *, void *data) {
  std::string *json = static_cast<std::string *>(data);
  if (env && callback) {
    napi_value argument, global;
    napi_create_string_utf8(env, json->c_str(), json->size(), &argument);
    napi_get_global(env, &global);
    napi_call_function(env, global, callback, 1, &argument, nullptr);
  }
  delete json;
}

@implementation ZPScanner

- (void)send:(NSDictionary *)event {
  if (self.stopped) return;
  napi_call_threadsafe_function(self.tsfn, new std::string(Json(event).UTF8String), napi_tsfn_nonblocking);
}

- (void)centralManagerDidUpdateState:(CBCentralManager *)central {
  switch (central.state) {
    case CBManagerStatePoweredOn:
      // Unfiltered, as Chromium scans: a filter by service can miss adverts that only carry service data.
      [central scanForPeripheralsWithServices:nil options:@{CBCentralManagerScanOptionAllowDuplicatesKey : @YES}];
      [self send:@{@"type" : @"scanning"}];
      break;
    case CBManagerStatePoweredOff:
      [self send:@{@"type" : @"error", @"reason" : @"off"}];
      break;
    case CBManagerStateUnauthorized:
      [self send:@{@"type" : @"error", @"reason" : @"denied"}];
      break;
    case CBManagerStateUnsupported:
      [self send:@{@"type" : @"error", @"reason" : @"unsupported"}];
      break;
    default:
      break;
  }
}

- (void)centralManager:(CBCentralManager *)central
    didDiscoverPeripheral:(CBPeripheral *)peripheral
        advertisementData:(NSDictionary<NSString *, id> *)advertisementData
                     RSSI:(NSNumber *)RSSI {
  NSDictionary<CBUUID *, NSData *> *serviceData = advertisementData[CBAdvertisementDataServiceDataKey];
  for (CBUUID *key in serviceData) {
    // 16-bit UUIDs come as "FFF9" or in their 128-bit Bluetooth base form.
    NSString *uuid = key.UUIDString.uppercaseString;
    if (uuid.length == 36 && [uuid hasPrefix:@"0000"] && [uuid hasSuffix:@"-0000-1000-8000-00805F9B34FB"]) uuid = [uuid substringWithRange:NSMakeRange(4, 4)];
    BOOL wanted = NO;
    for (CBUUID *service in self.services) wanted = wanted || [service.UUIDString.uppercaseString isEqualToString:uuid];
    NSData *data = serviceData[key];
    if (wanted && data.length) [self send:@{@"type" : @"advert", @"service" : uuid, @"data" : [data base64EncodedStringWithOptions:0]}];
  }
}

- (void)stop {
  if (self.stopped) return;
  self.stopped = YES;
  // CoreBluetooth is used from its own queue; releasing the callback there too means nothing is sent after it.
  dispatch_async(self.queue, ^{
    if (self.manager.state == CBManagerStatePoweredOn) [self.manager stopScan];
    self.manager.delegate = nil;
    napi_release_threadsafe_function(self.tsfn, napi_tsfn_release);
  });
}

@end

/** bleScan(servicesJson: string, onEvent: (json: string) => void): starts scanning (replacing any scan in progress). */
napi_value BleScan(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 2) return nullptr;
  [gScanner stop];
  gScanner = nil;

  std::string json = ArgString(env, argv[0]);
  NSArray *list = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json.data() length:json.size()] options:0 error:nil];
  NSMutableArray<CBUUID *> *services = [NSMutableArray array];
  if ([list isKindOfClass:[NSArray class]]) {
    for (id uuid in list) {
      if ([uuid isKindOfClass:[NSString class]]) [services addObject:[CBUUID UUIDWithString:uuid]];
    }
  }

  ZPScanner *scanner = [[ZPScanner alloc] init];
  scanner.services = services;
  napi_value name;
  napi_create_string_utf8(env, "zepper-ble", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function tsfn;
  napi_create_threadsafe_function(env, argv[1], nullptr, name, 0, 1, nullptr, nullptr, nullptr, Deliver, &tsfn);
  scanner.tsfn = tsfn;
  gScanner = scanner;
  scanner.queue = dispatch_queue_create("app.zepper.ble", DISPATCH_QUEUE_SERIAL);
  scanner.manager = [[CBCentralManager alloc] initWithDelegate:scanner
                                                         queue:scanner.queue
                                                       options:@{CBCentralManagerOptionShowPowerAlertKey : @NO}];
  return nullptr;
}

/** bleStop(): stops scanning. */
napi_value BleStop(napi_env env, napi_callback_info) {
  [gScanner stop];
  gScanner = nil;
  return nullptr;
}
