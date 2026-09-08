package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is set at build time via -ldflags "-X main.Version=vX.Y.Z" for
// tagged releases (see .github/workflows/build-windows.yml). Left as
// "dev" for local/untagged builds, which App.CheckForUpdate treats as
// "never report an update" — there's nothing meaningful to compare a
// local build against.
var Version = "dev"

func main() {
	appSvc := NewApp()

	app := application.New(application.Options{
		Name:        "seekers-epgp-parser",
		Description: "Seekers EPGP officer capture client",
		Services: []application.Service{
			application.NewService(appSvc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
	})

	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "seekers-epgp-parser",
		Width:            1024,
		Height:           768,
		BackgroundColour: application.NewRGB(27, 38, 54),
		URL:              "/",
	})

	// Close-confirmation (post-live-test-1 LT-24): if the Attendance or Bids
	// panel is holding work that was never submitted to the site — captured
	// /who snapshots, a live or in-review bid round — ask before quitting so
	// an officer doesn't lose a raid's worth of captures to a stray Cmd-Q.
	// The hook cancels this close, shows the dialog, and only actually
	// quits if they pick "Discard & quit" (which latches allowQuit so the
	// programmatic win.Close() goes straight through).
	win.RegisterHook(events.Common.WindowClosing, func(e *application.WindowEvent) {
		if appSvc.AllowQuit() || !appSvc.HasUnsavedWork() {
			return
		}
		e.Cancel()

		dialog := app.Dialog.Question()
		dialog.SetTitle("Unsubmitted data")
		dialog.SetMessage(
			"You have captured attendance or an open bid round that hasn't been submitted to the site. " +
				"Quit anyway and discard it?")
		dialog.AttachToWindow(win)
		discard := dialog.AddButton("Discard & quit")
		keep := dialog.AddButton("Keep working")
		keep.SetAsDefault()
		keep.SetAsCancel()
		discard.OnClick(func() {
			appSvc.SetAllowQuit(true)
			win.Close()
		})
		dialog.Show()
	})

	if err := app.Run(); err != nil {
		log.Fatal("Error:", err)
	}
}
