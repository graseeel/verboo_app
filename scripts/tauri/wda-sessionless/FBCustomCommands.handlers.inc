// VERBOO_SESSIONLESS_HANDLERS_BEGIN
#if !TARGET_OS_TV
+ (id<FBResponsePayload>)handleVerbooSettings:(FBRouteRequest *)request
{
  NSNumber *framerate = request.arguments[@"mjpegServerFramerate"];
  NSNumber *scale = request.arguments[@"mjpegScalingFactor"];
  if (![framerate isKindOfClass:NSNumber.class] ||
      !(framerate.unsignedIntegerValue == 30 || framerate.unsignedIntegerValue == 60)) {
    return FBVerbooInvalidArgument(@"mjpegServerFramerate must be 30 or 60");
  }
  if (![scale isKindOfClass:NSNumber.class] || !isfinite(scale.doubleValue) ||
      scale.doubleValue <= 0.0 || scale.doubleValue > 100.0) {
    return FBVerbooInvalidArgument(@"mjpegScalingFactor must be between 0 and 100");
  }
  [FBConfiguration setMjpegServerFramerate:framerate.unsignedIntegerValue];
  [FBConfiguration setMjpegScalingFactor:scale.doubleValue];
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleVerbooTap:(FBRouteRequest *)request
{
  NSNumber *x = request.arguments[@"x"];
  NSNumber *y = request.arguments[@"y"];
  UIInterfaceOrientation orientation = FBVerbooInterfaceOrientation(request);
  if (!FBVerbooFiniteCoordinate(x) || !FBVerbooFiniteCoordinate(y) ||
      orientation == UIInterfaceOrientationUnknown) {
    return FBVerbooInvalidArgument(@"x, y, and a supported orientation are required");
  }

  XCSynthesizedEventRecord *event = [[XCSynthesizedEventRecord alloc]
                                      initWithName:@"Verboo Tap"
                                      interfaceOrientation:orientation];
  XCPointerEventPath *path = [[XCPointerEventPath alloc]
                              initForTouchAtPoint:CGPointMake(x.doubleValue, y.doubleValue)
                              offset:0.0];
  [path liftUpAtOffset:0.05];
  [event addPointerEventPath:path];
  return FBVerbooSynthesizePointerEvent(event);
}

+ (id<FBResponsePayload>)handleVerbooDrag:(FBRouteRequest *)request
{
  NSNumber *fromX = request.arguments[@"fromX"];
  NSNumber *fromY = request.arguments[@"fromY"];
  NSNumber *toX = request.arguments[@"toX"];
  NSNumber *toY = request.arguments[@"toY"];
  NSNumber *duration = request.arguments[@"duration"];
  UIInterfaceOrientation orientation = FBVerbooInterfaceOrientation(request);
  if (!FBVerbooFiniteCoordinate(fromX) || !FBVerbooFiniteCoordinate(fromY) ||
      !FBVerbooFiniteCoordinate(toX) || !FBVerbooFiniteCoordinate(toY) ||
      ![duration isKindOfClass:NSNumber.class] || !isfinite(duration.doubleValue) ||
      duration.doubleValue < 0.05 || duration.doubleValue > 2.0 ||
      orientation == UIInterfaceOrientationUnknown) {
    return FBVerbooInvalidArgument(@"valid drag coordinates, duration, and orientation are required");
  }

  XCSynthesizedEventRecord *event = [[XCSynthesizedEventRecord alloc]
                                      initWithName:@"Verboo Drag"
                                      interfaceOrientation:orientation];
  XCPointerEventPath *path = [[XCPointerEventPath alloc]
                              initForTouchAtPoint:CGPointMake(fromX.doubleValue, fromY.doubleValue)
                              offset:0.0];
  [path moveToPoint:CGPointMake(toX.doubleValue, toY.doubleValue) atOffset:duration.doubleValue];
  [path liftUpAtOffset:duration.doubleValue + 0.01];
  [event addPointerEventPath:path];
  return FBVerbooSynthesizePointerEvent(event);
}

+ (id<FBResponsePayload>)handleVerbooType:(FBRouteRequest *)request
{
  NSString *text = request.arguments[@"text"];
  if (![text isKindOfClass:NSString.class] || text.length == 0 || text.length > 4000) {
    return FBVerbooInvalidArgument(@"text must contain between 1 and 4000 characters");
  }
  NSError *error;
  if (!FBTypeText(text, FBConfiguration.defaultTypingFrequency, &error)) {
    return FBResponseWithUnknownError(error);
  }
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleVerbooKey:(FBRouteRequest *)request
{
  NSNumber *page = request.arguments[@"page"];
  NSNumber *usage = request.arguments[@"usage"];
  NSNumber *duration = request.arguments[@"duration"];
  if (![page isKindOfClass:NSNumber.class] || page.unsignedIntegerValue != 0x07 ||
      ![usage isKindOfClass:NSNumber.class] || usage.unsignedIntegerValue == 0 ||
      ![duration isKindOfClass:NSNumber.class] || !isfinite(duration.doubleValue) ||
      duration.doubleValue <= 0.0 || duration.doubleValue > 0.1) {
    return FBVerbooInvalidArgument(@"a keyboard HID page, usage, and duration are required");
  }
  NSError *error;
  if (![XCUIDevice.sharedDevice fb_performIOHIDEventWithPage:page.unsignedIntValue
                                                       usage:usage.unsignedIntValue
                                                    duration:duration.doubleValue
                                                       error:&error]) {
    return FBResponseWithUnknownError(error);
  }
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleVerbooHome:(FBRouteRequest *)request
{
  // Sessionless home: fb_goToHomescreenWithError requires an active app
  // session and answers an empty 400 without one (measured on iOS 26.5),
  // and a direct IOHID AC Home press (Consumer page 0x0C / usage 0x40) is
  // rejected by the simulator runtime. XCUIDevice pressButton home is a
  // device-level event that works without a session — verified end-to-end
  // on iOS 26.5 (activeAppInfo returns com.apple.springboard afterwards).
  [XCUIDevice.sharedDevice pressButton:XCUIDeviceButtonHome];
  return FBResponseWithOK();
}

+ (id<FBResponsePayload>)handleVerbooSystemGesture:(FBRouteRequest *)request
{
  NSNumber *fromX = request.arguments[@"fromX"];
  NSNumber *fromY = request.arguments[@"fromY"];
  NSNumber *toX = request.arguments[@"toX"];
  NSNumber *toY = request.arguments[@"toY"];
  NSNumber *duration = request.arguments[@"duration"];
  NSNumber *hold = request.arguments[@"hold"];
  UIInterfaceOrientation orientation = FBVerbooInterfaceOrientation(request);
  if (!FBVerbooFiniteCoordinate(fromX) || !FBVerbooFiniteCoordinate(fromY) ||
      !FBVerbooFiniteCoordinate(toX) || !FBVerbooFiniteCoordinate(toY) ||
      !FBVerbooFiniteDuration(duration, 0.05, 2.0) ||
      !FBVerbooFiniteDuration(hold, 0.0, 1.0) ||
      orientation == UIInterfaceOrientationUnknown) {
    return FBVerbooInvalidArgument(@"valid gesture coordinates, timing, and orientation are required");
  }
  XCSynthesizedEventRecord *event = [[XCSynthesizedEventRecord alloc]
                                      initWithName:@"Verboo System Gesture"
                                      interfaceOrientation:orientation];
  XCPointerEventPath *path = [[XCPointerEventPath alloc]
                              initForTouchAtPoint:CGPointMake(fromX.doubleValue, fromY.doubleValue)
                              offset:0.0];
  [path moveToPoint:CGPointMake(toX.doubleValue, toY.doubleValue) atOffset:duration.doubleValue];
  [path liftUpAtOffset:duration.doubleValue + hold.doubleValue];
  [event addPointerEventPath:path];
  return FBVerbooSynthesizePointerEvent(event);
}

+ (id<FBResponsePayload>)handleVerbooRotate:(FBRouteRequest *)request
{
  NSString *orientation = request.arguments[@"orientation"];
  UIDeviceOrientation target = FBVerbooDeviceOrientation(orientation);
  if (target == UIDeviceOrientationUnknown) {
    return FBVerbooInvalidArgument(@"a supported orientation is required");
  }
  XCUIDevice.sharedDevice.orientation = target;
  return FBResponseWithOK();
}
#endif
// VERBOO_SESSIONLESS_HANDLERS_END
