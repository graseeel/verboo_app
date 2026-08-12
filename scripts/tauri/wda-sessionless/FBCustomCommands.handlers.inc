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
  NSUInteger moveSteps = MAX(1, (NSUInteger)ceil(duration.doubleValue * 60.0));
  for (NSUInteger step = 1; step <= moveSteps; step++) {
    double progress = (double)step / (double)moveSteps;
    CGPoint point = CGPointMake(
      fromX.doubleValue + ((toX.doubleValue - fromX.doubleValue) * progress),
      fromY.doubleValue + ((toY.doubleValue - fromY.doubleValue) * progress)
    );
    [path moveToPoint:point atOffset:duration.doubleValue * progress];
  }
  if (hold.doubleValue > 0.0) {
    // Emit an explicit stationary event at the end of the hold. Merely
    // delaying liftUp leaves no pointer sample for SpringBoard's App Switcher
    // recognizer on recent Simulator runtimes.
    [path moveToPoint:CGPointMake(toX.doubleValue, toY.doubleValue)
             atOffset:duration.doubleValue + hold.doubleValue];
  }
  [path liftUpAtOffset:duration.doubleValue + hold.doubleValue + 0.01];
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

+ (id<FBResponsePayload>)handleVerbooInspectPoint:(FBRouteRequest *)request
{
  NSNumber *x = request.arguments[@"x"];
  NSNumber *y = request.arguments[@"y"];
  NSNumber *windowWidth = request.arguments[@"windowWidth"];
  NSNumber *windowHeight = request.arguments[@"windowHeight"];
  BOOL exact = [request.arguments[@"exact"] boolValue];
  if (!FBVerbooFiniteCoordinate(x) || !FBVerbooFiniteCoordinate(y)) {
    return FBVerbooInvalidArgument(@"finite x and y coordinates are required");
  }

  id<XCTestManager_ManagerInterface> proxy = [FBXCTestDaemonsProxy testRunnerProxy];
  __block id<FBXCAccessibilityElement> element = nil;
  __block BOOL pointRequestCompleted = NO;
  [proxy _XCT_requestElementAtPoint:CGPointMake(x.doubleValue, y.doubleValue)
                              reply:^(id candidate, NSError *requestError) {
    element = nil == requestError ? candidate : nil;
    pointRequestCompleted = YES;
  }];
  FBRunLoopSpinner *pointSpinner = [[FBRunLoopSpinner alloc] init];
  [pointSpinner timeout:1.0];
  [pointSpinner interval:0.01];
  if (![pointSpinner spinUntilTrue:^BOOL {
    return pointRequestCompleted;
  }] || nil == element) {
    return FBResponseWithObject(@{@"found": @NO});
  }

  NSArray<NSString *> *attributeNames = @[
    @"XC_kAXXCAttributeAutomationType",
    @"XC_kAXXCAttributeIdentifier",
    @"XC_kAXXCAttributeLabel",
    @"XC_kAXXCAttributeTruncatedValue",
    @"XC_kAXXCAttributeFrame",
    @"XC_kAXXCAttributeIsUserInteractionEnabled",
  ];
  __block NSDictionary *attributes = nil;
  __block BOOL attributesRequestCompleted = NO;
  [proxy _XCT_fetchAttributes:attributeNames
                   forElement:element
                        reply:^(NSDictionary *fetchedAttributes, NSError *requestError) {
    attributes = nil == requestError ? fetchedAttributes : nil;
    attributesRequestCompleted = YES;
  }];
  FBRunLoopSpinner *attributesSpinner = [[FBRunLoopSpinner alloc] init];
  [attributesSpinner timeout:1.0];
  [attributesSpinner interval:0.01];
  if (![attributesSpinner spinUntilTrue:^BOOL {
    return attributesRequestCompleted;
  }] || nil == attributes) {
    return FBResponseWithObject(@{@"found": @NO});
  }

  NSDictionary *frameValue = attributes[@"XC_kAXXCAttributeFrame"];
  NSNumber *frameX = frameValue[@"X"];
  NSNumber *frameY = frameValue[@"Y"];
  NSNumber *frameWidth = frameValue[@"Width"];
  NSNumber *frameHeight = frameValue[@"Height"];
  BOOL hasFiniteFrame = FBVerbooFiniteCoordinate(frameX) && FBVerbooFiniteCoordinate(frameY) &&
    FBVerbooFiniteCoordinate(frameWidth) && FBVerbooFiniteCoordinate(frameHeight) &&
    frameWidth.doubleValue > 0.0 && frameHeight.doubleValue > 0.0;
  if (!hasFiniteFrame) return FBResponseWithObject(@{@"found": @NO});

  NSNumber *automationType = attributes[@"XC_kAXXCAttributeAutomationType"];
  XCUIElementType elementType = [automationType isKindOfClass:NSNumber.class]
    ? (XCUIElementType)automationType.unsignedIntegerValue
    : XCUIElementTypeOther;
  NSNumber *interactionEnabled = attributes[@"XC_kAXXCAttributeIsUserInteractionEnabled"];
  BOOL enabled = ![interactionEnabled isKindOfClass:NSNumber.class] || interactionEnabled.boolValue;
  NSString *identifier = FBVerbooInspectableText(attributes[@"XC_kAXXCAttributeIdentifier"]);
  NSString *label = FBVerbooInspectableText(attributes[@"XC_kAXXCAttributeLabel"]);
  NSString *value = FBVerbooInspectableText(attributes[@"XC_kAXXCAttributeTruncatedValue"]);
  NSString *uid = [FBElementUtils uidWithAccessibilityElement:element];
  BOOL coversViewport = FBVerbooFiniteCoordinate(windowWidth) &&
    FBVerbooFiniteCoordinate(windowHeight) &&
    frameWidth.doubleValue >= windowWidth.doubleValue * 0.9 &&
    frameHeight.doubleValue >= windowHeight.doubleValue * 0.9;
  CGPoint requestedPoint = CGPointMake(x.doubleValue, y.doubleValue);
  BOOL rawContainsPoint = FBVerbooFrameContainsPoint(
    CGRectMake(frameX.doubleValue, frameY.doubleValue, frameWidth.doubleValue, frameHeight.doubleValue),
    requestedPoint
  );
  if (!exact && (!rawContainsPoint || FBVerbooGenericElementType(elementType) || coversViewport)) {
    return FBResponseWithObject(@{@"found": @NO});
  }
  if (exact) {
    NSError *snapshotError = nil;
    id<FBXCElementSnapshot> elementSnapshot = [[FBXCAXClientProxy sharedClient]
      snapshotForElement:element
      attributes:nil
      inDepth:YES
      error:&snapshotError];
    id<FBXCElementSnapshot> refined = FBVerbooBestSnapshotAtPoint(elementSnapshot, requestedPoint);
    id<FBXCElementSnapshot> actionableAncestor = FBVerbooNearestActionableAncestor(refined, requestedPoint);
    if (nil != actionableAncestor) refined = actionableAncestor;
    BOOL refinedCoversViewport = nil != refined &&
      FBVerbooFiniteCoordinate(windowWidth) &&
      FBVerbooFiniteCoordinate(windowHeight) &&
      CGRectGetWidth(refined.frame) >= windowWidth.doubleValue * 0.9 &&
      CGRectGetHeight(refined.frame) >= windowHeight.doubleValue * 0.9;
    if (nil == refined ||
        FBVerbooGenericElementType(refined.elementType) ||
        !FBVerbooFrameContainsPoint(refined.frame, requestedPoint) ||
        refinedCoversViewport) {
      refined = FBVerbooDeepestSnapshotAtPoint(
        XCUIApplication.fb_activeApplication,
        requestedPoint
      );
    }
    if (nil != refined) {
      CGRect refinedFrame = refined.frame;
      frameX = @(CGRectGetMinX(refinedFrame));
      frameY = @(CGRectGetMinY(refinedFrame));
      frameWidth = @(CGRectGetWidth(refinedFrame));
      frameHeight = @(CGRectGetHeight(refinedFrame));
      elementType = refined.elementType;
      enabled = refined.enabled;
      identifier = FBVerbooInspectableText(refined.identifier);
      label = FBVerbooInspectableText(refined.label);
      value = FBVerbooInspectableText(refined.value);
      uid = [FBElementUtils uidWithAccessibilityElement:refined.accessibilityElement];
    }
  }
  CGRect selectedFrame = CGRectMake(
    frameX.doubleValue,
    frameY.doubleValue,
    frameWidth.doubleValue,
    frameHeight.doubleValue
  );
  if (!FBVerbooFrameContainsPoint(selectedFrame, requestedPoint)) {
    return FBResponseWithObject(@{@"found": @NO});
  }
  BOOL selectedCoversViewport = FBVerbooFiniteCoordinate(windowWidth) &&
    FBVerbooFiniteCoordinate(windowHeight) &&
    CGRectGetWidth(selectedFrame) >= windowWidth.doubleValue * 0.9 &&
    CGRectGetHeight(selectedFrame) >= windowHeight.doubleValue * 0.9;
  if (FBVerbooGenericElementType(elementType) || selectedCoversViewport) {
    return FBResponseWithObject(@{@"found": @NO});
  }
  NSString *role = [FBElementTypeTransformer shortStringWithElementType:elementType];
  BOOL actionable = enabled && FBVerbooActionableElementType(elementType);
  NSMutableDictionary *result = [@{
    @"found": @YES,
    @"id": uid ?: identifier ?: @"point-element",
    @"role": role ?: @"Other",
    @"frame": @{
      @"x": frameX,
      @"y": frameY,
      @"width": frameWidth,
      @"height": frameHeight,
    },
    @"enabled": @(enabled),
    @"visible": @YES,
    @"actionable": @(actionable),
  } mutableCopy];
  if (nil != identifier) result[@"identifier"] = identifier;
  if (nil != label) result[@"label"] = label;
  if (nil != value) result[@"value"] = value;
  return FBResponseWithObject(result);
}

+ (id<FBResponsePayload>)handleVerbooResolveTarget:(FBRouteRequest *)request
{
  NSString *target = request.arguments[@"target"];
  NSNumber *x = request.arguments[@"x"];
  NSNumber *y = request.arguments[@"y"];
  NSNumber *windowWidth = request.arguments[@"windowWidth"];
  NSNumber *windowHeight = request.arguments[@"windowHeight"];
  if (![target isKindOfClass:NSString.class] || target.length == 0 || target.length > 256 ||
      !FBVerbooFiniteCoordinate(x) || !FBVerbooFiniteCoordinate(y) ||
      !FBVerbooFiniteCoordinate(windowWidth) || windowWidth.doubleValue <= 0.0 ||
      !FBVerbooFiniteCoordinate(windowHeight) || windowHeight.doubleValue <= 0.0) {
    return FBVerbooInvalidArgument(@"target and finite window coordinates are required");
  }

  NSPredicate *targetPredicate = [NSPredicate predicateWithFormat:
    @"label ==[cd] %@ OR identifier ==[cd] %@ OR value ==[cd] %@",
    target, target, target];
  NSArray<XCUIElement *> *candidates = [[XCUIApplication.fb_activeApplication
    descendantsMatchingType:XCUIElementTypeAny]
    matchingPredicate:targetPredicate].allElementsBoundByIndex;
  CGPoint requestedPoint = CGPointMake(x.doubleValue, y.doubleValue);
  CGRect viewport = CGRectMake(0.0, 0.0, windowWidth.doubleValue, windowHeight.doubleValue);
  XCUIElement *(^closestActionableCandidate)(NSArray<XCUIElement *> *) =
    ^XCUIElement *(NSArray<XCUIElement *> *matches) {
      XCUIElement *closest = nil;
      CGFloat closestDistance = CGFLOAT_MAX;
      NSUInteger candidateLimit = MIN(matches.count, (NSUInteger)64);
      for (NSUInteger index = 0; index < candidateLimit; index++) {
        XCUIElement *candidate = matches[index];
        CGRect frame = candidate.frame;
        CGPoint center = CGPointMake(CGRectGetMidX(frame), CGRectGetMidY(frame));
        if (!candidate.enabled || !FBVerbooActionableElementType(candidate.elementType) ||
            CGRectIsNull(frame) || CGRectIsInfinite(frame) || CGRectIsEmpty(frame) ||
            !CGRectContainsPoint(viewport, center)) {
          continue;
        }
        CGFloat distance = FBVerbooDistanceSquaredToFrame(requestedPoint, frame);
        if (distance < closestDistance) {
          closestDistance = distance;
          closest = candidate;
        }
      }
      return closest;
    };
  XCUIElement *best = closestActionableCandidate(candidates);
  if (nil == best && target.length >= 3) {
    // Some iOS controls append dynamic metadata to their accessible label
    // (for example, a visible list name followed by its item count). Keep the
    // exact query as the fast path, then use the coordinate hint to disambiguate
    // a bounded contained-text fallback.
    NSPredicate *containedTargetPredicate = [NSPredicate predicateWithFormat:
      @"label CONTAINS[cd] %@ OR value CONTAINS[cd] %@", target, target];
    NSArray<XCUIElement *> *containedCandidates = [[XCUIApplication.fb_activeApplication
      descendantsMatchingType:XCUIElementTypeAny]
      matchingPredicate:containedTargetPredicate].allElementsBoundByIndex;
    best = closestActionableCandidate(containedCandidates);
  }
  if (nil == best) return FBResponseWithObject(@{@"found": @NO});

  CGRect frame = best.frame;
  NSString *identifier = FBVerbooInspectableText(best.identifier);
  NSString *label = FBVerbooInspectableText(best.label);
  NSString *value = FBVerbooInspectableText(best.value);
  NSString *role = [FBElementTypeTransformer shortStringWithElementType:best.elementType];
  NSMutableDictionary *result = [@{
    @"found": @YES,
    @"id": identifier ?: label ?: @"semantic-target",
    @"role": role ?: @"Other",
    @"frame": @{
      @"x": @(CGRectGetMinX(frame)),
      @"y": @(CGRectGetMinY(frame)),
      @"width": @(CGRectGetWidth(frame)),
      @"height": @(CGRectGetHeight(frame)),
    },
    @"enabled": @YES,
    @"visible": @YES,
    @"actionable": @YES,
  } mutableCopy];
  if (nil != label) result[@"label"] = label;
  if (nil != value) result[@"value"] = value;
  return FBResponseWithObject(result);
}

+ (id<FBResponsePayload>)handleVerbooFocusedElement:(FBRouteRequest *)request
{
  XCUIElement *element = XCUIApplication.fb_activeApplication.fb_activeElement;
  if (nil == element) {
    return FBResponseWithObject(@{@"found": @NO});
  }

  NSString *identifier = FBVerbooInspectableText(element.identifier);
  NSString *label = FBVerbooInspectableText(element.label);
  NSString *value = FBVerbooInspectableText(element.value);
  NSString *role = [FBElementTypeTransformer shortStringWithElementType:element.elementType];
  NSMutableDictionary *result = [@{
    @"found": @YES,
    @"role": role ?: @"Other",
    @"enabled": @(element.enabled),
    @"focused": @(element.hasKeyboardFocus),
  } mutableCopy];
  if (nil != identifier) result[@"identifier"] = identifier;
  if (nil != label) result[@"label"] = label;
  if (nil != value) result[@"value"] = value;
  return FBResponseWithObject(result);
}
#endif
// VERBOO_SESSIONLESS_HANDLERS_END
