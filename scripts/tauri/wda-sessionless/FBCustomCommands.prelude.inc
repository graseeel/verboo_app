// VERBOO_SESSIONLESS_PRELUDE_BEGIN
#import <math.h>

#import "FBXCTestDaemonsProxy.h"
#import "XCUIDevice+FBHelpers.h"
#import "XCUIElement+FBTyping.h"
#import "XCPointerEventPath.h"
#import "XCSynthesizedEventRecord.h"

static UIInterfaceOrientation FBVerbooInterfaceOrientation(FBRouteRequest *request)
{
  NSString *value = request.arguments[@"orientation"];
  if ([value isEqualToString:@"portrait"]) {
    return UIInterfaceOrientationPortrait;
  }
  if ([value isEqualToString:@"portraitUpsideDown"]) {
    return UIInterfaceOrientationPortraitUpsideDown;
  }
  if ([value isEqualToString:@"landscapeLeft"]) {
    return UIInterfaceOrientationLandscapeLeft;
  }
  if ([value isEqualToString:@"landscapeRight"]) {
    return UIInterfaceOrientationLandscapeRight;
  }
  return UIInterfaceOrientationUnknown;
}

static BOOL FBVerbooFiniteCoordinate(NSNumber *value)
{
  return [value isKindOfClass:NSNumber.class] && isfinite(value.doubleValue) && value.doubleValue >= 0.0;
}

static BOOL FBVerbooFiniteDuration(NSNumber *value, double minimum, double maximum)
{
  return [value isKindOfClass:NSNumber.class] && isfinite(value.doubleValue) &&
    value.doubleValue >= minimum && value.doubleValue <= maximum;
}

static UIDeviceOrientation FBVerbooDeviceOrientation(NSString *value)
{
  if ([value isEqualToString:@"portrait"]) return UIDeviceOrientationPortrait;
  if ([value isEqualToString:@"portraitUpsideDown"]) return UIDeviceOrientationPortraitUpsideDown;
  if ([value isEqualToString:@"landscapeLeft"]) return UIDeviceOrientationLandscapeRight;
  if ([value isEqualToString:@"landscapeRight"]) return UIDeviceOrientationLandscapeLeft;
  return UIDeviceOrientationUnknown;
}

static id<FBResponsePayload> FBVerbooInvalidArgument(NSString *message)
{
  return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:message traceback:nil]);
}

static id<FBResponsePayload> FBVerbooSynthesizePointerEvent(XCSynthesizedEventRecord *event)
{
  NSError *error;
  if (![FBXCTestDaemonsProxy synthesizeEventWithRecord:event error:&error]) {
    return FBResponseWithUnknownError(error);
  }
  return FBResponseWithOK();
}
// VERBOO_SESSIONLESS_PRELUDE_END
