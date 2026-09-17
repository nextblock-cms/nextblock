import React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@nextblock-cms/ui/avatar";
import { Card, CardContent } from "@nextblock-cms/ui/card";
import { MessageSquareQuote } from "lucide-react";
import type { VisualEditAttributes } from "../../../lib/visual-editing/types";

type TestimonialBlockContent = {
  quote?: string;
  author_name?: string;
  author_title?: string;
  image_url?: string;
};

interface TestimonialBlockRendererProps {
  content: TestimonialBlockContent;
  visualEditAttributes?: VisualEditAttributes;
}

const TestimonialBlockRenderer: React.FC<TestimonialBlockRendererProps> = ({
  content,
  visualEditAttributes,
}) => {
  const authorName = content.author_name || "Customer";

  return (
    <div className="container mx-auto my-8" {...visualEditAttributes}>
      <Card className="h-full">
        <CardContent className="pt-6 flex flex-col gap-4 h-full">
          <MessageSquareQuote className="w-8 h-8 text-primary/40" />
          {content.quote && (
            <blockquote className="flex-grow text-lg italic text-muted-foreground">
              &ldquo;{content.quote}&rdquo;
            </blockquote>
          )}
          <div className="flex items-center gap-3 mt-4">
            <Avatar>
              {content.image_url && (
                <AvatarImage src={content.image_url} alt={authorName} />
              )}
              <AvatarFallback>{authorName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div>
              <div className="font-semibold">{authorName}</div>
              {content.author_title && (
                <div className="text-sm text-muted-foreground">
                  {content.author_title}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default TestimonialBlockRenderer;
