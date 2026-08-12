// VERBOO_SESSIONLESS_PRELUDE_BEGIN
#import <math.h>

#import "FBElementTypeTransformer.h"
#import "FBElementUtils.h"
#import "FBRunLoopSpinner.h"
#import "FBXCAXClientProxy.h"
#import "FBXCElementSnapshot.h"
#import "FBXCTestDaemonsProxy.h"
#import "XCTestManager_ManagerInterface-Protocol.h"
#import "XCUIApplication+FBHelpers.h"
#import "XCUIDevice.h"
#import "XCUIDevice+FBHelpers.h"
#import "XCUIElement+FBTyping.h"
#import "XCUIElement+FBUtilities.h"
#import "XCPointerEventPath.h"
#import "XCSynthesizedEventRecord.h"

// Exact clicks may land on a leaf whose actionable Cell/Button ancestor is
// deeper than WDA's lightweight point snapshot. Keep hover on the fast path;
// this bounded full-tree depth is used only as an exact-click fallback.
static const int FB_VERBOO_EXACT_SNAPSHOT_MAX_DEPTH = 50;

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

static NSString *FBVerbooInspectableText(id value)
{
  if (nil == value || value == NSNull.null) return nil;
  NSString *text = [value isKindOfClass:NSString.class] ? value : [value description];
  if (text.length == 0) return nil;
  return text.length <= 512 ? text : [text substringToIndex:512];
}

static BOOL FBVerbooActionableElementType(XCUIElementType type)
{
  switch (type) {
    case XCUIElementTypeButton:
    case XCUIElementTypeLink:
    case XCUIElementTypeTextField:
    case XCUIElementTypeSecureTextField:
    case XCUIElementTypeTextView:
    case XCUIElementTypeSwitch:
    case XCUIElementTypeSlider:
    case XCUIElementTypeStepper:
    case XCUIElementTypeSegmentedControl:
    case XCUIElementTypePicker:
    case XCUIElementTypePickerWheel:
    case XCUIElementTypeCell:
    case XCUIElementTypeIcon:
      return YES;
    default:
      return NO;
  }
}

static BOOL FBVerbooGenericElementType(XCUIElementType type)
{
  return type == XCUIElementTypeAny ||
    type == XCUIElementTypeOther ||
    type == XCUIElementTypeApplication ||
    type == XCUIElementTypeWindow;
}

static BOOL FBVerbooFrameContainsPoint(CGRect frame, CGPoint point)
{
  return !CGRectIsNull(frame) && !CGRectIsInfinite(frame) && !CGRectIsEmpty(frame) &&
    CGRectContainsPoint(frame, point);
}

static CGFloat FBVerbooDistanceSquaredToFrame(CGPoint point, CGRect frame)
{
  CGFloat dx = point.x - CGRectGetMidX(frame);
  CGFloat dy = point.y - CGRectGetMidY(frame);
  return (dx * dx) + (dy * dy);
}

static id<FBXCElementSnapshot> FBVerbooBestSnapshotAtPoint(
  id<FBXCElementSnapshot> root,
  CGPoint point
)
{
  if (nil == root) return nil;

  id<FBXCElementSnapshot> smallest = nil;
  id<FBXCElementSnapshot> smallestDescriptive = nil;
  id<FBXCElementSnapshot> smallestActionable = nil;
  CGFloat smallestArea = CGFLOAT_MAX;
  CGFloat smallestDescriptiveArea = CGFLOAT_MAX;
  CGFloat smallestActionableArea = CGFLOAT_MAX;

  NSArray<id<FBXCElementSnapshot>> *candidates = [@[root]
    arrayByAddingObjectsFromArray:root._allDescendants];
  for (id<FBXCElementSnapshot> candidate in candidates) {
    CGRect frame = candidate.frame;
    if (!FBVerbooFrameContainsPoint(frame, point)) continue;
    CGFloat area = CGRectGetWidth(frame) * CGRectGetHeight(frame);
    if (area < smallestArea) {
      smallestArea = area;
      smallest = candidate;
    }
    if (!FBVerbooGenericElementType(candidate.elementType) &&
        area < smallestDescriptiveArea) {
      smallestDescriptiveArea = area;
      smallestDescriptive = candidate;
    }
    if (FBVerbooActionableElementType(candidate.elementType) &&
        area < smallestActionableArea) {
      smallestActionableArea = area;
      smallestActionable = candidate;
    }
  }
  return smallestActionable ?: smallestDescriptive ?: smallest;
}

static id<FBXCElementSnapshot> FBVerbooNearestActionableAncestor(
  id<FBXCElementSnapshot> snapshot,
  CGPoint point
)
{
  id<FBXCElementSnapshot> candidate = snapshot;
  while (nil != candidate) {
    if (FBVerbooActionableElementType(candidate.elementType) &&
        FBVerbooFrameContainsPoint(candidate.frame, point)) {
      return candidate;
    }
    candidate = candidate.parent;
  }
  return nil;
}

static id<FBXCElementSnapshot> FBVerbooDeepestSnapshotAtPoint(
  XCUIApplication *application,
  CGPoint point
)
{
  int previousMaxDepth = FBConfiguration.snapshotMaxDepth;
  [FBConfiguration setSnapshotMaxDepth:FB_VERBOO_EXACT_SNAPSHOT_MAX_DEPTH];
  id<FBXCElementSnapshot> root = nil;
  @try {
    root = application.fb_standardSnapshot;
  } @catch (NSException *exception) {
    root = nil;
  } @finally {
    [FBConfiguration setSnapshotMaxDepth:previousMaxDepth];
  }
  return FBVerbooBestSnapshotAtPoint(root, point);
}
// VERBOO_SESSIONLESS_PRELUDE_END
