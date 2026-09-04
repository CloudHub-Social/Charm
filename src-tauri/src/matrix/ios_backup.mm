#import <Foundation/Foundation.h>

extern "C" bool charm_exclude_search_root_from_backup(
    const char *app_data_path,
    const char *search_root_path) {
	@autoreleasepool {
		NSString *appData = [NSString stringWithUTF8String:app_data_path];
		NSString *searchRoot = [NSString stringWithUTF8String:search_root_path];
		if (appData == nil || searchRoot == nil) {
			return false;
		}

		NSArray<NSString *> *appComponents = appData.stringByStandardizingPath.pathComponents;
		NSArray<NSString *> *searchComponents = searchRoot.stringByStandardizingPath.pathComponents;
		if (searchComponents.count != appComponents.count + 1 ||
			![searchComponents.lastObject isEqualToString:@"message_search"]) {
			return false;
		}
		for (NSUInteger index = 0; index < appComponents.count; index++) {
			if (![appComponents[index] isEqualToString:searchComponents[index]]) {
				return false;
			}
		}

		NSURL *url = [NSURL fileURLWithPath:searchRoot isDirectory:YES];
		NSError *error = nil;
		return [url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error];
	}
}
