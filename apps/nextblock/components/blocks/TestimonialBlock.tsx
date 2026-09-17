import React from 'react';
import { z } from '../../lib/zod-config';
import { BlockConfig, BlockProps, BlockEditorProps } from '@nextblock-cms/sdk';
import { Avatar, AvatarFallback, AvatarImage } from '@nextblock-cms/ui/avatar';
import { Card, CardContent } from '@nextblock-cms/ui/card';
import { Input } from '@nextblock-cms/ui/input';
import { Label } from '@nextblock-cms/ui/label';
import { Textarea } from '@nextblock-cms/ui/textarea';
import { MessageSquareQuote } from 'lucide-react';

// 1. Define the Schema
export const TestimonialSchema = z.object({
  quote: z.string().min(1).describe('The testimonial text'),
  author_name: z.string().min(1).describe('The person who gave the testimonial'),
  author_title: z.string().optional().describe('Job title or company'),
  image_url: z.string().url().optional().or(z.literal('')).describe('Author profile image URL'),
});

// 2. Derive the Content Type
export type TestimonialBlockContent = z.infer<typeof TestimonialSchema>;

// 3. Create the Renderer Component
const TestimonialBlockRenderer: React.FC<BlockProps<typeof TestimonialSchema>> = ({ content }) => {
  return (
    <div className="container mx-auto my-8">
    <Card className="h-full">
      <CardContent className="pt-6 flex flex-col gap-4 h-full">
        <MessageSquareQuote className="w-8 h-8 text-primary/40" />
        
        <blockquote className="flex-grow text-lg italic text-muted-foreground">
          &ldquo;{content.quote}&rdquo;
        </blockquote>

        <div className="flex items-center gap-3 mt-4">
          <Avatar>
            {content.image_url && <AvatarImage src={content.image_url} alt={content.author_name} />}
            <AvatarFallback>{content.author_name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          
          <div>
            <div className="font-semibold">{content.author_name}</div>
            {content.author_title && (
              <div className="text-sm text-muted-foreground">{content.author_title}</div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
    </div>
  );
};

// 4. Create the Editor Component
const TestimonialBlockEditor: React.FC<BlockEditorProps<typeof TestimonialSchema>> = ({ content, onChange }) => {
  const handleChange = (key: keyof TestimonialBlockContent, value: string) => {
    onChange({
      ...content,
      [key]: value,
    });
  };

  return (
    <div className="space-y-4 p-1">
      <div className="space-y-2">
        <Label htmlFor="quote">Quote</Label>
        <Textarea
          id="quote"
          value={content.quote}
          onChange={(e) => handleChange('quote', e.target.value)}
          placeholder="Enter the testimonial quote..."
          rows={4}
        />
      </div>
      
      <div className="space-y-2">
        <Label htmlFor="author_name">Author Name</Label>
        <Input
          id="author_name"
          value={content.author_name}
          onChange={(e) => handleChange('author_name', e.target.value)}
          placeholder="John Doe"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="author_title">Author Title (Optional)</Label>
        <Input
          id="author_title"
          value={content.author_title || ''}
          onChange={(e) => handleChange('author_title', e.target.value)}
          placeholder="CEO, Company Inc."
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="image_url">Author Image URL (Optional)</Label>
        <div className="flex gap-2">
            <Input
            id="image_url"
            value={content.image_url || ''}
            onChange={(e) => handleChange('image_url', e.target.value)}
            placeholder="https://example.com/image.jpg"
            />
        </div>
        {content.image_url && (
            <div className="mt-2 w-16 h-16 relative rounded-full overflow-hidden border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={content.image_url} alt="Preview" className="w-full h-full object-cover" />
            </div>
        )}
      </div>
    </div>
  );
};

// 5. Export the Block Configuration
export const TestimonialBlockConfig: BlockConfig<typeof TestimonialSchema> = {
  type: 'testimonial',
  label: 'Testimonial',
  icon: MessageSquareQuote,
  schema: TestimonialSchema,
  initialContent: {
    quote: "This product changed my life! The workflow is so much smoother now.",
    author_name: "Jane Doe",
    author_title: "CEO, TechCorp",
    image_url: "",
  },
  RendererComponent: TestimonialBlockRenderer,
  EditorComponent: TestimonialBlockEditor,
};
