#include "bindings/bindings.h"
#import <Foundation/Foundation.h>

namespace {
static NSString * const kMessageSearchDirectory = @"message_search";
static NSString * const kBackupExclusionMarker = @".ios-backup-excluded";

void prepareMessageSearchDirectory() {
	NSFileManager *fileManager = NSFileManager.defaultManager;
	NSError *error = nil;
	NSURL *applicationSupport = [fileManager
		URLForDirectory:NSApplicationSupportDirectory
		inDomain:NSUserDomainMask
		appropriateForURL:nil
		create:YES
		error:&error];
	if (applicationSupport == nil) {
		return;
	}

	NSString *bundleIdentifier = NSBundle.mainBundle.bundleIdentifier;
	if (bundleIdentifier == nil) {
		return;
	}

	// Match Tauri's app_data_dir: data_dir/<bundle identifier>. Excluding the
	// dedicated parent directory excludes every per-account/device SQLCipher
	// database and its WAL/SHM sidecars without affecting unrelated app data.
	NSURL *searchRoot = [[[applicationSupport
		URLByAppendingPathComponent:bundleIdentifier
		isDirectory:YES]
		URLByAppendingPathComponent:kMessageSearchDirectory
		isDirectory:YES] standardizedURL];
	NSURL *marker = [searchRoot URLByAppendingPathComponent:kBackupExclusionMarker];
	if ([fileManager fileExistsAtPath:marker.path]
		&& ![fileManager removeItemAtURL:marker error:&error]) {
		return;
	}
	if (![fileManager createDirectoryAtURL:searchRoot
		withIntermediateDirectories:YES
		attributes:@{NSFilePosixPermissions: @0700}
		error:&error]) {
		return;
	}
	if (![searchRoot setResourceValue:@YES
		forKey:NSURLIsExcludedFromBackupKey
		error:&error]) {
		return;
	}

	// Rust requires this marker before opening an index, so a native backup-
	// exclusion failure disables search instead of silently creating backup-
	// eligible decrypted-content derivatives.
	[@"excluded\n" writeToURL:marker
		atomically:YES
		encoding:NSUTF8StringEncoding
		error:nil];
}
} // namespace

int main(int argc, char * argv[]) {
	@autoreleasepool {
		prepareMessageSearchDirectory();
		ffi::start_app();
	}
	return 0;
}
