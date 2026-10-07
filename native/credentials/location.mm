// Location Services for Zepper: whether macOS lets Zepper use your location, and asking you (macOS's
// own prompt) the first time a site wants it. Chromium's location code, which Electron uses, reads
// the location once Zepper is allowed, but only asks macOS when the browser tells it to, and Electron
// never does; without this, a site waiting for your location just times out.

#import <CoreLocation/CoreLocation.h>
#include <vector>
#include "bridge.h"

static NSString *StatusName(CLAuthorizationStatus status) {
  if (![CLLocationManager locationServicesEnabled]) return @"disabled";
  switch (status) {
    case kCLAuthorizationStatusNotDetermined:
      return @"not-determined";
    case kCLAuthorizationStatusRestricted:
      return @"restricted";
    case kCLAuthorizationStatusDenied:
      return @"denied";
    default:
      return @"granted";
  }
}

/** Keeps the manager alive while macOS asks, and settles everyone waiting once you've answered. */
@interface ZepperLocationAccess : NSObject <CLLocationManagerDelegate>
@property(nonatomic, strong) CLLocationManager *manager;
@end

static std::vector<napi_threadsafe_function> waiting;

@implementation ZepperLocationAccess
- (void)locationManagerDidChangeAuthorization:(CLLocationManager *)manager {
  if (manager.authorizationStatus == kCLAuthorizationStatusNotDetermined) return;
  NSString *json = Json(@[ StatusName(manager.authorizationStatus) ]);
  json = [json substringWithRange:NSMakeRange(1, json.length - 2)];
  for (napi_threadsafe_function tsfn : waiting) Finish(tsfn, json, true);
  waiting.clear();
}
@end

static ZepperLocationAccess *access_ = nil;

static CLLocationManager *Manager() {
  if (!access_) {
    access_ = [[ZepperLocationAccess alloc] init];
    access_.manager = [[CLLocationManager alloc] init];
    access_.manager.delegate = access_;
  }
  return access_.manager;
}

/** locationAccess(): string — "granted", "denied", "restricted", "not-determined" or "disabled" (Location Services off). */
napi_value LocationAccess(napi_env env, napi_callback_info) {
  NSString *name = StatusName(Manager().authorizationStatus);
  napi_value result;
  napi_create_string_utf8(env, name.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}

/** requestLocationAccess(): Promise<string> — asks once (macOS's prompt) and resolves with the answer as JSON. */
napi_value RequestLocationAccess(napi_env env, napi_callback_info) {
  napi_value promise;
  Pending *pending = NewPending(env, &promise);
  CLLocationManager *manager = Manager();
  if (manager.authorizationStatus != kCLAuthorizationStatusNotDetermined || ![CLLocationManager locationServicesEnabled]) {
    NSString *json = Json(@[ StatusName(manager.authorizationStatus) ]);
    Finish(pending->tsfn, [json substringWithRange:NSMakeRange(1, json.length - 2)], true);
    return promise;
  }
  waiting.push_back(pending->tsfn);
  [manager requestWhenInUseAuthorization];
  return promise;
}
