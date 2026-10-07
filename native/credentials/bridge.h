// Shared by the passkey and system halves of the credentials addon: native results reach
// JavaScript as JSON strings, settling a promise on the JavaScript thread through a threadsafe function.
#pragma once

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#include <node_api.h>
#include <string>

struct Pending {
  napi_deferred deferred;
  napi_threadsafe_function tsfn;
};

struct Outcome {
  std::string json;
  bool ok;
};

static inline NSString *Json(id object) {
  if (!object || object == [NSNull null]) return @"null";
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"{}";
}

/** Settles the JavaScript promise (on the JavaScript thread, through the threadsafe function). */
static inline void Settle(napi_env env, napi_value, void *context, void *data) {
  Pending *pending = static_cast<Pending *>(context);
  Outcome *outcome = static_cast<Outcome *>(data);
  if (env && outcome) {
    napi_value value;
    napi_create_string_utf8(env, outcome->json.c_str(), outcome->json.size(), &value);
    if (outcome->ok) napi_resolve_deferred(env, pending->deferred, value);
    else napi_reject_deferred(env, pending->deferred, value);
  }
  delete outcome;
}

static inline void FinalizePending(napi_env, void *data, void *) { delete static_cast<Pending *>(data); }

/** A promise plus the threadsafe function that will settle it once. */
static inline Pending *NewPending(napi_env env, napi_value *promise) {
  Pending *pending = new Pending();
  napi_create_promise(env, &pending->deferred, promise);
  napi_value name;
  napi_create_string_utf8(env, "zepper-credentials", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(env, nullptr, nullptr, name, 0, 1, pending, FinalizePending, pending, Settle, &pending->tsfn);
  return pending;
}

/** Settles a pending promise with a JSON string (once; the threadsafe function is released). */
static inline void Finish(napi_threadsafe_function tsfn, NSString *json, bool ok) {
  Outcome *outcome = new Outcome{std::string(json.UTF8String), ok};
  napi_call_threadsafe_function(tsfn, outcome, napi_tsfn_nonblocking);
  napi_release_threadsafe_function(tsfn, napi_tsfn_release);
}

static inline std::string ArgString(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::string out(length, '\0');
  napi_get_value_string_utf8(env, value, out.data(), length + 1, &length);
  return out;
}

/** The NSWindow behind an Electron window's getNativeWindowHandle() (an NSView pointer). */
static inline NSWindow *WindowFromHandle(napi_env env, napi_value handle) {
  void *bytes = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, handle, &bytes, &length) != napi_ok || length < sizeof(void *)) return nil;
  NSView *view = (__bridge NSView *)(*reinterpret_cast<void **>(bytes));
  return view.window;
}

napi_value VerifyOwner(napi_env env, napi_callback_info info);
napi_value ReadKeychain(napi_env env, napi_callback_info info);
napi_value BleScan(napi_env env, napi_callback_info info);
napi_value LocationAccess(napi_env env, napi_callback_info info);
napi_value FileTypeIcon(napi_env env, napi_callback_info info);
napi_value RequestLocationAccess(napi_env env, napi_callback_info info);
napi_value BleStop(napi_env env, napi_callback_info info);
