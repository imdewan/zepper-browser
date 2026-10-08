// macOS services Zepper's password manager uses: proving you're the Mac's owner (Touch ID, an Apple
// Watch or the login password) before passkeys sign in or saved passwords are shown, and reading
// another browser's Keychain key when you import its passwords (macOS asks you first).

#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#import <Security/Security.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include "bridge.h"

/** verifyOwner(reason: string): Promise<string> — "true", "false" (cancelled or failed) or "\"unavailable\"" (no way to verify). */
napi_value VerifyOwner(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value promise;
  Pending *pending = NewPending(env, &promise);
  NSString *reason = argc > 0 ? [NSString stringWithUTF8String:ArgString(env, argv[0]).c_str()] : @"";
  if (reason.length == 0) reason = @"confirm it’s you";

  LAContext *context = [[LAContext alloc] init];
  NSError *error = nil;
  if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error]) {
    Finish(pending->tsfn, @"\"unavailable\"", true);
    return promise;
  }
  napi_threadsafe_function tsfn = pending->tsfn;
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
          localizedReason:reason
                    reply:^(BOOL success, NSError *_Nullable) {
                      Finish(tsfn, success ? @"true" : @"false", true);
                    }];
  return promise;
}

/** readKeychain(service: string, account: string): Promise<string> — the item's secret as a JSON string, or null. */
napi_value ReadKeychain(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value promise;
  Pending *pending = NewPending(env, &promise);
  if (argc < 2) {
    Finish(pending->tsfn, @"null", true);
    return promise;
  }
  NSString *service = [NSString stringWithUTF8String:ArgString(env, argv[0]).c_str()];
  NSString *account = [NSString stringWithUTF8String:ArgString(env, argv[1]).c_str()];
  napi_threadsafe_function tsfn = pending->tsfn;
  // macOS may show its "wants to use your confidential information" prompt; wait off the main thread.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSDictionary *query = @{
      (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService : service,
      (__bridge id)kSecAttrAccount : account,
      (__bridge id)kSecReturnData : @YES,
      (__bridge id)kSecMatchLimit : (__bridge id)kSecMatchLimitOne,
    };
    CFTypeRef result = nullptr;
    OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
    NSString *secret = nil;
    if (status == errSecSuccess && result) {
      NSData *data = (__bridge_transfer NSData *)result;
      secret = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    }
    Finish(tsfn, secret ? Json(@[ secret ]) : @"null", true);
  });
  return promise;
}

/**
 * fileTypeIcon(extension: string, size: number): string — the icon Finder shows for a kind of file
 * ("pdf", "zip"…), as a PNG data URL ('' if macOS has none). Drawn here, on the main thread, because
 * Electron's own app.getFileIcon crashes on this Electron build.
 */
napi_value FileTypeIcon(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  NSString *extension = argc > 0 ? [NSString stringWithUTF8String:ArgString(env, argv[0]).c_str()] : @"";
  double points = 64;
  if (argc > 1) napi_get_value_double(env, argv[1], &points);
  points = MAX(16, MIN(points, 512));
  NSString *url = @"";
  @autoreleasepool {
    UTType *type = extension.length > 0 ? [UTType typeWithFilenameExtension:extension] : nil;
    NSImage *icon = [[NSWorkspace sharedWorkspace] iconForContentType:type ?: UTTypeData];
    if (icon) {
      NSSize size = NSMakeSize(points, points);
      NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr
                                                                         pixelsWide:(NSInteger)points
                                                                         pixelsHigh:(NSInteger)points
                                                                      bitsPerSample:8
                                                                    samplesPerPixel:4
                                                                           hasAlpha:YES
                                                                           isPlanar:NO
                                                                     colorSpaceName:NSDeviceRGBColorSpace
                                                                        bytesPerRow:0
                                                                       bitsPerPixel:0];
      bitmap.size = size;
      [NSGraphicsContext saveGraphicsState];
      NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
      [icon drawInRect:NSMakeRect(0, 0, points, points) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1];
      [NSGraphicsContext restoreGraphicsState];
      NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      if (png) url = [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]];
    }
  }
  napi_value result;
  napi_create_string_utf8(env, url.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}

/**
 * desktopPicture(maxWidth: number): string — the main screen's desktop picture as a JPEG data URL, at
 * most maxWidth pixels wide ('' when macOS doesn't say, or it isn't an image file), for Portrait Mode.
 */
napi_value DesktopPicture(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  double maxWidth = 1600;
  if (argc > 0) napi_get_value_double(env, argv[0], &maxWidth);
  maxWidth = MAX(64, MIN(maxWidth, 4096));
  NSString *url = @"";
  @autoreleasepool {
    NSScreen *screen = NSScreen.mainScreen;
    NSURL *file = screen ? [[NSWorkspace sharedWorkspace] desktopImageURLForScreen:screen] : nil;
    NSImage *image = file ? [[NSImage alloc] initWithContentsOfURL:file] : nil;
    NSImageRep *rep = image.representations.firstObject;
    CGFloat pixelsWide = rep && rep.pixelsWide > 0 ? rep.pixelsWide : image.size.width;
    CGFloat pixelsHigh = rep && rep.pixelsHigh > 0 ? rep.pixelsHigh : image.size.height;
    if (image && pixelsWide > 0 && pixelsHigh > 0) {
      CGFloat width = MIN(maxWidth, pixelsWide);
      CGFloat height = round(width * pixelsHigh / pixelsWide);
      NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr
                                                                         pixelsWide:(NSInteger)width
                                                                         pixelsHigh:(NSInteger)height
                                                                      bitsPerSample:8
                                                                    samplesPerPixel:4
                                                                           hasAlpha:YES
                                                                           isPlanar:NO
                                                                     colorSpaceName:NSDeviceRGBColorSpace
                                                                        bytesPerRow:0
                                                                       bitsPerPixel:0];
      bitmap.size = NSMakeSize(width, height);
      [NSGraphicsContext saveGraphicsState];
      NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
      [image drawInRect:NSMakeRect(0, 0, width, height) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1];
      [NSGraphicsContext restoreGraphicsState];
      NSData *jpeg = [bitmap representationUsingType:NSBitmapImageFileTypeJPEG properties:@{NSImageCompressionFactor : @0.85}];
      if (jpeg) url = [@"data:image/jpeg;base64," stringByAppendingString:[jpeg base64EncodedStringWithOptions:0]];
    }
  }
  napi_value result;
  napi_create_string_utf8(env, url.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}
