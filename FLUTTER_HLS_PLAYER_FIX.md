# Flutter HLS Player Fix for Better Player Plus

## Problem
ExoPlayer is not recognizing the `.m3u8` stream as HLS format, causing `UnrecognizedInputFormatException`.

## Solution: Configure Better Player Plus for HLS

Update your Flutter code to explicitly specify HLS format:

```dart
import 'package:flutter/material.dart';
import 'package:better_player_plus/better_player_plus.dart';

class AudioHLSPlayer extends StatefulWidget {
  final String url; // The .m3u8 URL
  const AudioHLSPlayer({required this.url, super.key});

  @override
  State<AudioHLSPlayer> createState() => _AudioHLSPlayerState();
}

class _AudioHLSPlayerState extends State<AudioHLSPlayer> {
  late BetterPlayerController _betterPlayerController;

  @override
  void initState() {
    super.initState();

    // Configuration for HLS audio/video
    BetterPlayerConfiguration betterPlayerConfiguration =
        BetterPlayerConfiguration(
      autoPlay: true,
      looping: false,
      controlsConfiguration: BetterPlayerControlsConfiguration(
        showControls: true,
        enableProgressText: true,
        enablePlayPause: true,
        enableProgressBar: true,
      ),
      allowedScreenSleep: false,
      aspectRatio: 16 / 9,
      // IMPORTANT: Add these HLS-specific configurations
      hlsConfiguration: BetterPlayerHlsConfiguration(
        // Enable HLS support
        enableHls: true,
      ),
    );

    // Data source - IMPORTANT: Use BetterPlayerDataSourceType.hls
    BetterPlayerDataSource dataSource = BetterPlayerDataSource(
      BetterPlayerDataSourceType.hls, // ← Change this from 'network' to 'hls'
      widget.url,
      // HLS specific config
      useAsmsSubtitles: true,
      useAsmsAudioTracks: true,
    );

    _betterPlayerController = BetterPlayerController(
      betterPlayerConfiguration,
      betterPlayerDataSource: dataSource, // ← Pass dataSource here
    );
  }

  @override
  void dispose() {
    _betterPlayerController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black12,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            "Audio Player",
            style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
          ),
          SizedBox(height: 8),
          AspectRatio(
            aspectRatio: 16 / 9,
            child: BetterPlayer(controller: _betterPlayerController),
          ),
        ],
      ),
    );
  }
}
```

## Key Changes:

1. **Change DataSourceType**: Use `BetterPlayerDataSourceType.hls` instead of `BetterPlayerDataSourceType.network`
2. **Add HLS Configuration**: Include `hlsConfiguration` in `BetterPlayerConfiguration`
3. **Pass DataSource to Controller**: Use `betterPlayerDataSource` parameter in controller constructor

## Alternative: If BetterPlayerDataSourceType.hls doesn't exist

If your version of better_player_plus doesn't have `BetterPlayerDataSourceType.hls`, try this:

```dart
BetterPlayerDataSource dataSource = BetterPlayerDataSource(
  BetterPlayerDataSourceType.network,
  widget.url,
  useAsmsSubtitles: true,
  useAsmsAudioTracks: true,
  // Add format hint
  formatHint: BetterPlayerFormat.hls, // ← Add this
);
```

## Debugging Steps:

1. **Check the URL**: Open the proxy URL in a browser and verify it returns the `.m3u8` content
2. **Check Content-Type**: The response should have `Content-Type: application/vnd.apple.mpegurl`
3. **Check Logs**: Look at server logs to see what content is being served
4. **Test with VLC**: Try opening the URL in VLC player to verify it's valid HLS

## If Still Not Working:

Try using `video_player` package with HLS support, or `chewie` with `video_player`:

```dart
// Alternative using video_player
import 'package:video_player/video_player.dart';

final controller = VideoPlayerController.networkUrl(
  Uri.parse(widget.url),
  videoPlayerOptions: VideoPlayerOptions(
    mixWithOthers: true,
  ),
  httpHeaders: {
    'Accept': 'application/vnd.apple.mpegurl',
  },
);
```

