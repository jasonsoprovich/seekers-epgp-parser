package main

import (
	"embed"
	"log"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is set at build time via -ldflags "-X main.Version=vX.Y.Z" for
// tagged releases (see .github/workflows/build-windows.yml). Left as
// "dev" for local/untagged builds, which updatecheck treats as "never
// report an update" — there's nothing meaningful to compare a local build
// against.
var Version = "dev"

func main() {
	app := application.New(application.Options{
		Name:        "seekers-epgp-parser",
		Description: "Seekers EPGP officer capture client",
		Services: []application.Service{
			application.NewService(NewApp()),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "seekers-epgp-parser",
		Width:            1024,
		Height:           768,
		BackgroundColour: application.NewRGB(27, 38, 54),
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		log.Fatal("Error:", err)
	}
}
