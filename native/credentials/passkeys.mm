// Passkeys and security keys for Zepper, through macOS's own WebAuthn support (AuthenticationServices):
// iCloud Keychain passkeys, a phone nearby (QR code) and USB/NFC security keys, with the system's
// own sheets anchored to the Zepper window. Runs in Electron's main process, which is what holds
// Apple's browser entitlement (com.apple.developer.web-browser.public-key-credential). Without
// that entitlement macOS refuses every request, so available() reports false and pages keep
// Chromium's own behaviour.
//
// The JavaScript side passes requests and receives results as JSON strings; binary fields are
// base64url, as in WebAuthn's own JSON forms.

#import <AppKit/AppKit.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include "bridge.h"

static NSString *const kEntitlement = @"com.apple.developer.web-browser.public-key-credential";

// ---- base64url ---------------------------------------------------------------

static NSString *Base64Url(NSData *data) {
  if (!data) return nil;
  NSString *b64 = [data base64EncodedStringWithOptions:0];
  b64 = [b64 stringByReplacingOccurrencesOfString:@"+" withString:@"-"];
  b64 = [b64 stringByReplacingOccurrencesOfString:@"/" withString:@"_"];
  return [b64 stringByReplacingOccurrencesOfString:@"=" withString:@""];
}

static NSData *FromBase64Url(id value) {
  if (![value isKindOfClass:[NSString class]]) return nil;
  NSString *b64 = [(NSString *)value stringByReplacingOccurrencesOfString:@"-" withString:@"+"];
  b64 = [b64 stringByReplacingOccurrencesOfString:@"_" withString:@"/"];
  while (b64.length % 4) b64 = [b64 stringByAppendingString:@"="];
  return [[NSData alloc] initWithBase64EncodedString:b64 options:0];
}

static NSString *String(id value) { return [value isKindOfClass:[NSString class]] ? value : nil; }

// ---- Requests ----------------------------------------------------------------

typedef void (^Completion)(NSDictionary *result, NSDictionary *error);

API_AVAILABLE(macos(14.4))
@interface ZPRequest : NSObject <ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) ASAuthorizationController *controller;
@property(nonatomic, copy) Completion completion;
@end

static ZPRequest *gCurrent API_AVAILABLE(macos(14.4)) = nil;

static NSString *Attachment(ASAuthorizationPublicKeyCredentialAttachment attachment) API_AVAILABLE(macos(14.4)) {
  return attachment == ASAuthorizationPublicKeyCredentialAttachmentPlatform ? @"platform" : @"cross-platform";
}

/** Maps AuthenticationServices errors to the DOMException names WebAuthn uses. */
static NSDictionary *ErrorFor(NSError *error) {
  NSString *name = @"NotAllowedError";
  NSString *message = error.localizedDescription ?: @"The operation either timed out or was not allowed.";
  if ([error.domain isEqualToString:ASAuthorizationErrorDomain]) {
    switch (error.code) {
      case ASAuthorizationErrorCanceled:
        message = @"The operation either timed out or was not allowed.";
        break;
      case 1006:  // ASAuthorizationErrorMatchedExcludedCredential
        name = @"InvalidStateError";
        message = @"The authenticator was previously registered.";
        break;
      case ASAuthorizationErrorNotHandled:
      case ASAuthorizationErrorInvalidResponse:
      case ASAuthorizationErrorFailed:
      default:
        break;
    }
  }
  return @{@"name" : name, @"message" : message};
}

@implementation ZPRequest

- (ASPresentationAnchor)presentationAnchorForAuthorizationController:(ASAuthorizationController *)controller {
  return self.window;
}

- (void)finish:(NSDictionary *)result error:(NSDictionary *)error {
  Completion completion = self.completion;
  self.completion = nil;
  if (gCurrent == self) gCurrent = nil;
  if (completion) completion(result, error);
}

- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithAuthorization:(ASAuthorization *)authorization {
  id credential = authorization.credential;
  NSMutableDictionary *result = [NSMutableDictionary dictionary];
  if ([credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialRegistration class]]) {
    ASAuthorizationPlatformPublicKeyCredentialRegistration *c = credential;
    result[@"type"] = @"create";
    result[@"id"] = Base64Url(c.credentialID);
    result[@"clientDataJSON"] = Base64Url(c.rawClientDataJSON);
    result[@"attestationObject"] = Base64Url(c.rawAttestationObject);
    result[@"attachment"] = Attachment(c.attachment);
    result[@"transports"] = c.attachment == ASAuthorizationPublicKeyCredentialAttachmentPlatform ? @[ @"hybrid", @"internal" ] : @[ @"hybrid" ];
  } else if ([credential isKindOfClass:[ASAuthorizationSecurityKeyPublicKeyCredentialRegistration class]]) {
    ASAuthorizationSecurityKeyPublicKeyCredentialRegistration *c = credential;
    result[@"type"] = @"create";
    result[@"id"] = Base64Url(c.credentialID);
    result[@"clientDataJSON"] = Base64Url(c.rawClientDataJSON);
    result[@"attestationObject"] = Base64Url(c.rawAttestationObject);
    result[@"attachment"] = @"cross-platform";
    NSMutableArray *transports = [NSMutableArray array];
    if (@available(macOS 14.5, *)) {
      for (NSString *t in c.transports) [transports addObject:[t lowercaseString]];
    }
    result[@"transports"] = transports.count ? transports : @[ @"usb" ];
  } else if ([credential isKindOfClass:[ASAuthorizationPlatformPublicKeyCredentialAssertion class]]) {
    ASAuthorizationPlatformPublicKeyCredentialAssertion *c = credential;
    result[@"type"] = @"get";
    result[@"id"] = Base64Url(c.credentialID);
    result[@"clientDataJSON"] = Base64Url(c.rawClientDataJSON);
    result[@"authenticatorData"] = Base64Url(c.rawAuthenticatorData);
    result[@"signature"] = Base64Url(c.signature);
    if (c.userID.length) result[@"userHandle"] = Base64Url(c.userID);
    result[@"attachment"] = Attachment(c.attachment);
  } else if ([credential isKindOfClass:[ASAuthorizationSecurityKeyPublicKeyCredentialAssertion class]]) {
    ASAuthorizationSecurityKeyPublicKeyCredentialAssertion *c = credential;
    result[@"type"] = @"get";
    result[@"id"] = Base64Url(c.credentialID);
    result[@"clientDataJSON"] = Base64Url(c.rawClientDataJSON);
    result[@"authenticatorData"] = Base64Url(c.rawAuthenticatorData);
    result[@"signature"] = Base64Url(c.signature);
    if (c.userID.length) result[@"userHandle"] = Base64Url(c.userID);
    result[@"attachment"] = @"cross-platform";
    if (@available(macOS 14.5, *)) result[@"appid"] = @(c.appID);
  } else {
    return [self finish:nil error:@{@"name" : @"NotAllowedError", @"message" : @"Unexpected credential."}];
  }
  [self finish:result error:nil];
}

- (void)authorizationController:(ASAuthorizationController *)controller didCompleteWithError:(NSError *)error {
  [self finish:nil error:ErrorFor(error)];
}

@end

static ASAuthorizationPublicKeyCredentialUserVerificationPreference Verification(NSString *value) API_AVAILABLE(macos(14.4)) {
  if ([value isEqualToString:@"required"]) return ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired;
  if ([value isEqualToString:@"discouraged"]) return ASAuthorizationPublicKeyCredentialUserVerificationPreferenceDiscouraged;
  return ASAuthorizationPublicKeyCredentialUserVerificationPreferencePreferred;
}

static NSArray<ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransport> *Transports(id list) API_AVAILABLE(macos(14.4)) {
  NSMutableArray *transports = [NSMutableArray array];
  if ([list isKindOfClass:[NSArray class]]) {
    for (id t in list) {
      if ([t isEqual:@"usb"]) [transports addObject:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportUSB];
      else if ([t isEqual:@"nfc"]) [transports addObject:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportNFC];
      else if ([t isEqual:@"ble"]) [transports addObject:ASAuthorizationSecurityKeyPublicKeyCredentialDescriptorTransportBluetooth];
    }
  }
  return transports.count ? transports : ASAuthorizationAllSupportedPublicKeyCredentialDescriptorTransports();
}

static ASPublicKeyCredentialClientData *ClientData(NSDictionary *request) API_AVAILABLE(macos(14.4)) {
  ASPublicKeyCredentialClientData *clientData =
      [[ASPublicKeyCredentialClientData alloc] initWithChallenge:FromBase64Url(request[@"challenge"]) origin:String(request[@"origin"])];
  NSString *topOrigin = String(request[@"topOrigin"]);
  if (topOrigin) {
    clientData.topOrigin = topOrigin;
    clientData.crossOrigin = ASPublicKeyCredentialClientDataCrossOriginValueCrossOrigin;
  } else {
    clientData.crossOrigin = ASPublicKeyCredentialClientDataCrossOriginValueSameOriginWithAncestors;
  }
  return clientData;
}

/** Builds the requests for create(); nil when the request can't be served. */
static NSArray<ASAuthorizationRequest *> *CreateRequests(NSDictionary *request, NSDictionary **error) API_AVAILABLE(macos(14.4)) {
  NSString *rpId = String(request[@"rpId"]);
  NSDictionary *user = [request[@"user"] isKindOfClass:[NSDictionary class]] ? request[@"user"] : @{};
  NSData *userID = FromBase64Url(user[@"id"]);
  NSString *name = String(user[@"name"]) ?: @"";
  NSString *displayName = String(user[@"displayName"]) ?: name;
  NSArray *algorithms = [request[@"algorithms"] isKindOfClass:[NSArray class]] ? request[@"algorithms"] : @[ @(-7) ];
  NSArray *excluded = [request[@"excludeCredentials"] isKindOfClass:[NSArray class]] ? request[@"excludeCredentials"] : @[];
  NSString *verification = String(request[@"userVerification"]);
  NSMutableArray<ASAuthorizationRequest *> *requests = [NSMutableArray array];

  // iCloud Keychain passkeys (and a phone nearby) only make ES256 keys.
  if ([request[@"platform"] boolValue] && [algorithms containsObject:@(-7)]) {
    ASAuthorizationPlatformPublicKeyCredentialProvider *provider =
        [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
    ASAuthorizationPlatformPublicKeyCredentialRegistrationRequest *registration =
        [provider createCredentialRegistrationRequestWithClientData:ClientData(request) name:name userID:userID];
    registration.displayName = displayName;
    registration.userVerificationPreference = Verification(verification);
    registration.shouldShowHybridTransport = [request[@"hybrid"] boolValue];
    NSMutableArray *exclude = [NSMutableArray array];
    for (NSDictionary *d in excluded) {
      NSData *credentialID = FromBase64Url(d[@"id"]);
      if (credentialID) [exclude addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc] initWithCredentialID:credentialID]];
    }
    registration.excludedCredentials = exclude;
    [requests addObject:registration];
  }

  if ([request[@"securityKey"] boolValue]) {
    ASAuthorizationSecurityKeyPublicKeyCredentialProvider *provider =
        [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
    ASAuthorizationSecurityKeyPublicKeyCredentialRegistrationRequest *registration =
        [provider createCredentialRegistrationRequestWithClientData:ClientData(request) displayName:displayName name:name userID:userID];
    NSMutableArray *parameters = [NSMutableArray array];
    for (id alg in algorithms) {
      if ([alg isKindOfClass:[NSNumber class]]) [parameters addObject:[[ASAuthorizationPublicKeyCredentialParameters alloc] initWithAlgorithm:[alg integerValue]]];
    }
    registration.credentialParameters = parameters;
    registration.userVerificationPreference = Verification(verification);
    NSString *residentKey = String(request[@"residentKey"]);
    registration.residentKeyPreference = [residentKey isEqualToString:@"required"]
                                             ? ASAuthorizationPublicKeyCredentialResidentKeyPreferenceRequired
                                         : [residentKey isEqualToString:@"preferred"]
                                             ? ASAuthorizationPublicKeyCredentialResidentKeyPreferencePreferred
                                             : ASAuthorizationPublicKeyCredentialResidentKeyPreferenceDiscouraged;
    NSString *attestation = String(request[@"attestation"]);
    registration.attestationPreference = [attestation isEqualToString:@"direct"]       ? ASAuthorizationPublicKeyCredentialAttestationKindDirect
                                         : [attestation isEqualToString:@"indirect"]   ? ASAuthorizationPublicKeyCredentialAttestationKindIndirect
                                         : [attestation isEqualToString:@"enterprise"] ? ASAuthorizationPublicKeyCredentialAttestationKindEnterprise
                                                                                       : ASAuthorizationPublicKeyCredentialAttestationKindNone;
    NSMutableArray *exclude = [NSMutableArray array];
    for (NSDictionary *d in excluded) {
      NSData *credentialID = FromBase64Url(d[@"id"]);
      if (credentialID)
        [exclude addObject:[[ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor alloc] initWithCredentialID:credentialID
                                                                                                    transports:Transports(d[@"transports"])]];
    }
    registration.excludedCredentials = exclude;
    [requests addObject:registration];
  }

  if (requests.count == 0) *error = @{@"name" : @"NotSupportedError", @"message" : @"None of the requested algorithms are supported."};
  return requests;
}

/** Builds the requests for get(). */
static NSArray<ASAuthorizationRequest *> *GetRequests(NSDictionary *request) API_AVAILABLE(macos(14.4)) {
  NSString *rpId = String(request[@"rpId"]);
  NSArray *allowed = [request[@"allowCredentials"] isKindOfClass:[NSArray class]] ? request[@"allowCredentials"] : @[];
  NSString *verification = String(request[@"userVerification"]);
  NSMutableArray<ASAuthorizationRequest *> *requests = [NSMutableArray array];

  if ([request[@"platform"] boolValue]) {
    ASAuthorizationPlatformPublicKeyCredentialProvider *provider =
        [[ASAuthorizationPlatformPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
    ASAuthorizationPlatformPublicKeyCredentialAssertionRequest *assertion = [provider createCredentialAssertionRequestWithClientData:ClientData(request)];
    assertion.userVerificationPreference = Verification(verification);
    assertion.shouldShowHybridTransport = [request[@"hybrid"] boolValue];
    NSMutableArray *allow = [NSMutableArray array];
    for (NSDictionary *d in allowed) {
      NSData *credentialID = FromBase64Url(d[@"id"]);
      if (credentialID) [allow addObject:[[ASAuthorizationPlatformPublicKeyCredentialDescriptor alloc] initWithCredentialID:credentialID]];
    }
    assertion.allowedCredentials = allow;
    [requests addObject:assertion];
  }

  if ([request[@"securityKey"] boolValue]) {
    ASAuthorizationSecurityKeyPublicKeyCredentialProvider *provider =
        [[ASAuthorizationSecurityKeyPublicKeyCredentialProvider alloc] initWithRelyingPartyIdentifier:rpId];
    ASAuthorizationSecurityKeyPublicKeyCredentialAssertionRequest *assertion = [provider createCredentialAssertionRequestWithClientData:ClientData(request)];
    assertion.userVerificationPreference = Verification(verification);
    NSMutableArray *allow = [NSMutableArray array];
    for (NSDictionary *d in allowed) {
      NSData *credentialID = FromBase64Url(d[@"id"]);
      if (credentialID)
        [allow addObject:[[ASAuthorizationSecurityKeyPublicKeyCredentialDescriptor alloc] initWithCredentialID:credentialID
                                                                                                  transports:Transports(d[@"transports"])]];
    }
    assertion.allowedCredentials = allow;
    if (@available(macOS 14.5, *)) {
      NSString *appid = String(request[@"appid"]);
      if (appid) assertion.appID = appid;
    }
    [requests addObject:assertion];
  }
  return requests;
}

// ---- Node-API ----------------------------------------------------------------

static bool HasEntitlement() {
  SecTaskRef task = SecTaskCreateFromSelf(kCFAllocatorDefault);
  if (!task) return false;
  CFTypeRef value = SecTaskCopyValueForEntitlement(task, (__bridge CFStringRef)kEntitlement, nullptr);
  CFRelease(task);
  bool granted = value && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)value);
  if (value) CFRelease(value);
  return granted;
}

/** available(): whether this process may use passkeys (macOS 14.4+ and Apple's browser entitlement). */
static napi_value Available(napi_env env, napi_callback_info) {
  bool available = false;
  if (@available(macOS 14.4, *)) available = HasEntitlement();
  napi_value result;
  napi_get_boolean(env, available, &result);
  return result;
}

/** perform(windowHandle: Buffer, requestJson: string): Promise<string> — rejects with an error JSON string. */
static napi_value Perform(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  napi_value promise;
  Pending *pending = NewPending(env, &promise);
  auto fail = [&](NSDictionary *error) {
    Finish(pending->tsfn, Json(error), false);
    return promise;
  };

  if (argc < 2) return fail(@{@"name" : @"TypeError", @"message" : @"Missing arguments."});
  if (@available(macOS 14.4, *)) {
    NSWindow *window = WindowFromHandle(env, argv[0]);
    if (!window) return fail(@{@"name" : @"TypeError", @"message" : @"Missing window."});

    std::string json = ArgString(env, argv[1]);
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json.data() length:json.size()] options:0 error:nil];
    if (![request isKindOfClass:[NSDictionary class]]) return fail(@{@"name" : @"TypeError", @"message" : @"Bad request."});
    if (gCurrent) return fail(@{@"name" : @"NotAllowedError", @"message" : @"Another request is in progress."});

    NSDictionary *error = nil;
    NSArray<ASAuthorizationRequest *> *requests =
        [request[@"kind"] isEqual:@"create"] ? CreateRequests(request, &error) : GetRequests(request);
    if (requests.count == 0) return fail(error ?: @{@"name" : @"NotAllowedError", @"message" : @"No authenticator can handle this request."});

    ZPRequest *zp = [[ZPRequest alloc] init];
    zp.window = window;
    napi_threadsafe_function tsfn = pending->tsfn;
    zp.completion = ^(NSDictionary *result, NSDictionary *err) {
      Finish(tsfn, Json(result ?: err), result != nil);
    };
    zp.controller = [[ASAuthorizationController alloc] initWithAuthorizationRequests:requests];
    zp.controller.delegate = zp;
    zp.controller.presentationContextProvider = zp;
    gCurrent = zp;
    [zp.controller performRequests];
    return promise;
  }
  return fail(@{@"name" : @"NotSupportedError", @"message" : @"Passkeys need macOS 14.4 or later."});
}

/** cancel(): dismisses the request in progress (the page aborted it). */
static napi_value Cancel(napi_env env, napi_callback_info) {
  if (@available(macOS 14.4, *)) {
    ZPRequest *current = gCurrent;
    if (current) {
      [current.controller cancel];
      [current finish:nil error:@{@"name" : @"AbortError", @"message" : @"The operation was aborted."}];
    }
  }
  return nullptr;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"available", nullptr, Available, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"perform", nullptr, Perform, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"cancel", nullptr, Cancel, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"verifyOwner", nullptr, VerifyOwner, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readKeychain", nullptr, ReadKeychain, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"bleScan", nullptr, BleScan, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"bleStop", nullptr, BleStop, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"locationAccess", nullptr, LocationAccess, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"fileTypeIcon", nullptr, FileTypeIcon, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"desktopPicture", nullptr, DesktopPicture, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"requestLocationAccess", nullptr, RequestLocationAccess, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
