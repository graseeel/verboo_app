    // VERBOO_SESSIONLESS_ROUTES_BEGIN
#if !TARGET_OS_TV
    [[FBRoute POST:@"/wda/verboo/settings"].withoutSession respondWithTarget:self action:@selector(handleVerbooSettings:)],
    [[FBRoute POST:@"/wda/verboo/tap"].withoutSession respondWithTarget:self action:@selector(handleVerbooTap:)],
    [[FBRoute POST:@"/wda/verboo/drag"].withoutSession respondWithTarget:self action:@selector(handleVerbooDrag:)],
    [[FBRoute POST:@"/wda/verboo/type"].withoutSession respondWithTarget:self action:@selector(handleVerbooType:)],
    [[FBRoute POST:@"/wda/verboo/key"].withoutSession respondWithTarget:self action:@selector(handleVerbooKey:)],
    [[FBRoute POST:@"/wda/verboo/home"].withoutSession respondWithTarget:self action:@selector(handleVerbooHome:)],
    [[FBRoute POST:@"/wda/verboo/systemGesture"].withoutSession respondWithTarget:self action:@selector(handleVerbooSystemGesture:)],
    [[FBRoute POST:@"/wda/verboo/rotate"].withoutSession respondWithTarget:self action:@selector(handleVerbooRotate:)],
    [[FBRoute POST:@"/wda/verboo/inspectPoint"].withoutSession respondWithTarget:self action:@selector(handleVerbooInspectPoint:)],
    [[FBRoute POST:@"/wda/verboo/resolveTarget"].withoutSession respondWithTarget:self action:@selector(handleVerbooResolveTarget:)],
    [[FBRoute POST:@"/wda/verboo/focusedElement"].withoutSession respondWithTarget:self action:@selector(handleVerbooFocusedElement:)],
#endif
    // VERBOO_SESSIONLESS_ROUTES_END
