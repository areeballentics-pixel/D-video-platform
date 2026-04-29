// Obj-C macro-based RN module registration. Pairs with SvpVideoPlayerModule.swift.
//
// React Native's `RCT_EXTERN_MODULE` family registers each method's selector
// on the JS bridge. The module name "SvpVideoPlayer" must match the
// `@objc(SvpVideoPlayer)` attribute on the Swift class AND the JS-side
// `NativeModules.SvpVideoPlayer` lookup.

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(SvpVideoPlayer, NSObject)

RCT_EXTERN_METHOD(isReady:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(play:(NSDictionary *)params
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(pause:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(resume:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(seek:(NSNumber *)positionMs
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(stop:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(getPosition:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(runSecurityChecks:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
