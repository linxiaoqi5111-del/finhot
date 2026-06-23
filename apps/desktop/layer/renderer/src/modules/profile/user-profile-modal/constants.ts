// Social platform icons mapping
export const socialIconClassNames = {
  twitter: "i-focal-twitter duration-200 group-hover:text-[#1DA1F2]",
  github: "i-focal-github duration-200 group-hover:text-[#181717] group-hover:dark:invert",
  instagram: "i-focal-instagram duration-200 group-hover:text-[#C13584]",
  facebook: "i-focal-facebook duration-200 group-hover:text-[#1877F2]",
  youtube: "i-focal-youtube duration-200 group-hover:text-[#FF0000]",
  discord: "i-focal-discord duration-200 group-hover:text-[#5865F2]",
}

export const socialCopyMap = {
  twitter: "Twitter",
  github: "GitHub",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  discord: "Discord",
}

export const getSocialLink = (platform: keyof typeof socialIconClassNames, id: string) => {
  switch (platform) {
    case "twitter": {
      return `https://twitter.com/${id}`
    }
    case "github": {
      return `https://github.com/${id}`
    }
    case "instagram": {
      return `https://instagram.com/${id}`
    }
    case "facebook": {
      return `https://facebook.com/${id}`
    }
    case "youtube": {
      return `https://youtube.com/${id}`
    }
    case "discord": {
      return `https://discord.com/${id}`
    }
  }
}
