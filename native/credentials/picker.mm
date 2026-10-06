// Filling from Apple Passwords without Apple's browser entitlement: macOS offers its own
// "Passwords…" AutoFill button under any app's native password field, and filling one opens the
// system's password picker (with Touch ID). Zepper shows a small native panel at the web page's
// sign-in field with such a pair of fields, waits for AutoFill to fill them, and hands the login
// back to fill the page. Nothing is stored or remembered here.

#import <AppKit/AppKit.h>
#include "bridge.h"

@interface ZPPickerPanel : NSPanel
@property(nonatomic, copy) void (^onCancel)(void);
@end

@implementation ZPPickerPanel
- (BOOL)canBecomeKeyWindow {
  return YES;
}
- (void)cancelOperation:(id)sender {
  if (self.onCancel) self.onCancel();
}
@end

@interface ZPPicker : NSObject
@property(nonatomic, strong) ZPPickerPanel *panel;
@property(nonatomic, strong) NSTextField *user;
@property(nonatomic, strong) NSSecureTextField *pass;
@property(nonatomic, strong) NSTimer *timer;
@property(nonatomic, weak) NSWindow *parent;
@property(nonatomic) napi_threadsafe_function tsfn;
@property(nonatomic) BOOL done;
@property(nonatomic) NSInteger settledTicks;
@end

static ZPPicker *gPicker = nil;

@implementation ZPPicker

- (void)finishWith:(NSDictionary *)login {
  if (self.done) return;
  self.done = YES;
  [self.timer invalidate];
  NSWindow *parent = self.parent;
  if (parent) [parent removeChildWindow:self.panel];
  [self.panel orderOut:nil];
  [parent makeKeyAndOrderFront:nil];
  Finish(self.tsfn, Json(login), true);
  // Last: this may release the final reference to self.
  if (gPicker == self) gPicker = nil;
}

- (void)cancel:(id)sender {
  [self finishWith:nil];
}

/** AutoFill fills both fields at once: wait until the password is in and nothing changes for a moment. */
- (void)tick {
  if (self.pass.stringValue.length == 0) {
    self.settledTicks = 0;
    return;
  }
  if (++self.settledTicks < 2) return;
  [self finishWith:@{@"username" : self.user.stringValue ?: @"", @"password" : self.pass.stringValue}];
}

@end

static NSTextField *Label(NSString *text, CGFloat size, NSFontWeight weight, NSColor *color) {
  NSTextField *label = [NSTextField labelWithString:text];
  label.font = [NSFont systemFontOfSize:size weight:weight];
  label.textColor = color;
  label.lineBreakMode = NSLineBreakByWordWrapping;
  label.maximumNumberOfLines = 2;
  return label;
}

/** pickPassword(windowHandle, json {x, y, width} in window points from the top left): Promise<string> — a login JSON, or "null". */
napi_value PickPassword(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value promise;
  Pending *pending = NewPending(env, &promise);
  if (argc < 2 || gPicker) {
    Finish(pending->tsfn, @"null", true);
    return promise;
  }
  NSWindow *window = WindowFromHandle(env, argv[0]);
  std::string json = ArgString(env, argv[1]);
  NSDictionary *place = [NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:json.data() length:json.size()] options:0 error:nil];
  if (!window || ![place isKindOfClass:[NSDictionary class]]) {
    Finish(pending->tsfn, @"null", true);
    return promise;
  }

  const CGFloat width = MAX(300, MIN(380, [place[@"width"] doubleValue]));
  const CGFloat height = 138;
  NSRect content = [window contentRectForFrameRect:window.frame];
  NSRect frame = NSMakeRect(content.origin.x + [place[@"x"] doubleValue],
                            content.origin.y + content.size.height - [place[@"y"] doubleValue] - height, width, height);

  ZPPicker *picker = [[ZPPicker alloc] init];
  picker.tsfn = pending->tsfn;
  picker.parent = window;

  ZPPickerPanel *panel = [[ZPPickerPanel alloc] initWithContentRect:frame
                                                          styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                            backing:NSBackingStoreBuffered
                                                              defer:NO];
  panel.opaque = NO;
  panel.backgroundColor = NSColor.clearColor;
  panel.hasShadow = YES;
  panel.floatingPanel = YES;
  panel.becomesKeyOnlyIfNeeded = NO;
  __weak ZPPicker *weakPicker = picker;
  panel.onCancel = ^{
    [weakPicker finishWith:nil];
  };

  NSVisualEffectView *background = [[NSVisualEffectView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
  background.material = NSVisualEffectMaterialPopover;
  background.state = NSVisualEffectStateActive;
  background.wantsLayer = YES;
  background.layer.cornerRadius = 10;
  background.layer.masksToBounds = YES;
  panel.contentView = background;

  const CGFloat inset = 14;
  NSTextField *title = Label(@"Fill from Apple Passwords", 13, NSFontWeightSemibold, NSColor.labelColor);
  title.frame = NSMakeRect(inset, height - 30, width - inset * 2 - 70, 18);
  [background addSubview:title];
  NSTextField *hint = Label(@"Choose Passwords… below, then pick a login.", 11.5, NSFontWeightRegular, NSColor.secondaryLabelColor);
  hint.frame = NSMakeRect(inset, height - 48, width - inset * 2, 16);
  [background addSubview:hint];

  NSButton *cancel = [NSButton buttonWithTitle:@"Cancel" target:picker action:@selector(cancel:)];
  cancel.controlSize = NSControlSizeSmall;
  cancel.bezelStyle = NSBezelStyleRounded;
  cancel.keyEquivalent = @"\e";
  [cancel sizeToFit];
  cancel.frame = NSMakeRect(width - inset - cancel.frame.size.width, height - 32, cancel.frame.size.width, cancel.frame.size.height);
  [background addSubview:cancel];

  NSTextField *user = [[NSTextField alloc] initWithFrame:NSMakeRect(inset, 48, width - inset * 2, 24)];
  user.placeholderString = @"User name";
  user.contentType = NSTextContentTypeUsername;
  user.bezelStyle = NSTextFieldRoundedBezel;
  [background addSubview:user];
  NSSecureTextField *pass = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(inset, 14, width - inset * 2, 24)];
  pass.placeholderString = @"Password";
  pass.contentType = NSTextContentTypePassword;
  pass.bezelStyle = NSTextFieldRoundedBezel;
  [background addSubview:pass];

  picker.panel = panel;
  picker.user = user;
  picker.pass = pass;
  [window addChildWindow:panel ordered:NSWindowAbove];
  [panel makeKeyAndOrderFront:nil];
  [panel makeFirstResponder:pass];
  picker.timer = [NSTimer scheduledTimerWithTimeInterval:0.25 target:picker selector:@selector(tick) userInfo:nil repeats:YES];
  // Left open and unused: give up after a few minutes.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(180 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    [weakPicker finishWith:nil];
  });
  gPicker = picker;
  return promise;
}

/** cancelPick(): closes the picker (the tab changed, or the page went away). */
napi_value CancelPick(napi_env env, napi_callback_info) {
  [gPicker finishWith:nil];
  return nullptr;
}
